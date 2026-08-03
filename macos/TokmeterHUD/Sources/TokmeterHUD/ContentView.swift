import AppKit
import SwiftUI

// MARK: - Preferences

enum HUDPreferences {
    static let keepOnTopKey = "keepOnTop"
    static let refreshIntervalKey = "refreshIntervalSeconds"

    static let intervalOptions: [Int] = [15, 30, 60, 120]
    static let defaultInterval = 30
}

// MARK: - View model

@MainActor
final class HUDModel: ObservableObject {
    @Published var accounts: [AccountSnapshot] = []
    @Published var fetchedAt: Date?
    @Published var isLoading = false
    @Published var globalError: String?
    @Published var binaryPath: String?

    var refreshIntervalSeconds: Int = HUDPreferences.defaultInterval

    private var timer: Timer?
    private var refreshTask: Task<Void, Never>?

    func start() {
        binaryPath = TokmeterService.resolveBinary()
        Task { await refresh() }
        rescheduleTimer()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        refreshTask?.cancel()
        refreshTask = nil
    }

    func rescheduleTimer() {
        timer?.invalidate()
        let interval = TimeInterval(max(5, refreshIntervalSeconds))
        let t = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in
                await self?.refresh()
            }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func refresh() async {
        refreshTask?.cancel()
        let task = Task {
            isLoading = true
            defer { isLoading = false }

            binaryPath = TokmeterService.resolveBinary()

            do {
                let payload = try await TokmeterService.fetch()
                if Task.isCancelled { return }
                accounts = payload.accounts
                fetchedAt = Formatters.parseISO8601(payload.fetchedAt) ?? Date()
                globalError = nil
            } catch is CancellationError {
                return
            } catch {
                if Task.isCancelled { return }
                globalError = error.localizedDescription
            }
        }
        refreshTask = task
        await task.value
    }
}

// MARK: - Root content

struct ContentView: View {
    @StateObject private var model = HUDModel()
    @AppStorage(HUDPreferences.keepOnTopKey) private var keepOnTop = false
    @AppStorage(HUDPreferences.refreshIntervalKey) private var refreshIntervalSeconds =
        HUDPreferences.defaultInterval

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().opacity(0.35)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if let globalError = model.globalError, model.accounts.isEmpty {
                        errorBanner(globalError)
                    } else if model.accounts.isEmpty, !model.isLoading {
                        emptyState
                    } else {
                        ForEach(model.accounts) { account in
                            AccountBlock(account: account)
                        }
                        if let globalError = model.globalError {
                            Text(globalError)
                                .font(.system(size: 11))
                                .foregroundStyle(.orange.opacity(0.9))
                                .padding(.top, 4)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(minWidth: 340, idealWidth: 420, maxWidth: .infinity,
               minHeight: 240, idealHeight: 520, maxHeight: .infinity)
        .background(Color(red: 0.09, green: 0.09, blue: 0.11))
        .preferredColorScheme(.dark)
        .background(WindowConfigurator(keepOnTop: keepOnTop))
        .onAppear {
            model.refreshIntervalSeconds = refreshIntervalSeconds
            model.start()
        }
        .onDisappear { model.stop() }
        .onChange(of: refreshIntervalSeconds) { newValue in
            model.refreshIntervalSeconds = newValue
            model.rescheduleTimer()
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text("tokmeter")
                .font(.system(size: 14, weight: .semibold, design: .rounded))
                .foregroundStyle(Color.white.opacity(0.92))

            Spacer(minLength: 8)

            Button {
                Task { await model.refresh() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 12, weight: .semibold))
                    .rotationEffect(.degrees(model.isLoading ? 360 : 0))
                    .animation(
                        model.isLoading
                            ? .linear(duration: 0.85).repeatForever(autoreverses: false)
                            : .default,
                        value: model.isLoading
                    )
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.white.opacity(0.75))
            .help("Refresh now")
            .disabled(model.isLoading)
            .keyboardShortcut("r", modifiers: [.command])

            Text(model.fetchedAt.map { Formatters.headerTime($0) } ?? "—")
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .foregroundStyle(Color.white.opacity(0.45))
                .help("Last updated")

            Menu {
                Toggle("Keep on Top", isOn: $keepOnTop)

                Menu("Refresh Interval") {
                    ForEach(HUDPreferences.intervalOptions, id: \.self) { secs in
                        Button {
                            refreshIntervalSeconds = secs
                        } label: {
                            if refreshIntervalSeconds == secs {
                                Label("\(secs)s", systemImage: "checkmark")
                            } else {
                                Text("\(secs)s")
                            }
                        }
                    }
                }

                Divider()
                if let path = model.binaryPath {
                    Text(path)
                        .font(.system(size: 10))
                } else {
                    Text("tokmeter not found — set TOKMETER_BIN")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.system(size: 13, weight: .medium))
                    .frame(width: 22, height: 20)
                    .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .frame(width: 24)
            .foregroundStyle(Color.white.opacity(0.7))
            .help("Settings")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("No accounts")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white.opacity(0.85))
            Text("Run `tokmeter accounts list` or set TOKMETER_BIN so this app can find the CLI.")
                .font(.system(size: 12))
                .foregroundStyle(.white.opacity(0.45))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 12)
    }

    private func errorBanner(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Error")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color.red.opacity(0.9))
            Text(message)
                .font(.system(size: 12))
                .foregroundStyle(.white.opacity(0.7))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 8)
    }
}

// MARK: - Account + window rows

struct AccountBlock: View {
    let account: AccountSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(account.displayTitle)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.white.opacity(0.92))
                .lineLimit(2)

            if !account.ok {
                HStack(alignment: .top, spacing: 6) {
                    Text("error")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Color.red.opacity(0.95))
                    Text(account.error ?? "unknown error")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.white.opacity(0.55))
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                ForEach(account.windows.filter { win in
                    // Prefer rich local stats over coarse Grok "Local sessions" row
                    !(account.provider == "grok"
                        && win.id == "local"
                        && account.local != nil
                        && !(account.local?.lines.isEmpty ?? true))
                }) { window in
                    WindowRow(window: window)
                }
            }

            if let local = account.local, !local.lines.isEmpty {
                ForEach(local.lines) { line in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(line.label)
                            .font(.system(size: 12))
                            .foregroundStyle(Color.white.opacity(0.45))
                            .frame(width: 100, alignment: .leading)
                        Text(line.value)
                            .font(.system(size: 12))
                            .foregroundStyle(Color.cyan.opacity(0.9))
                            .lineLimit(2)
                        Spacer(minLength: 0)
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }
}

struct WindowRow: View {
    let window: UsageWindow

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: 8) {
                label
                    .frame(width: 120, alignment: .leading)
                metricsRow
                Spacer(minLength: 0)
            }
            VStack(alignment: .leading, spacing: 4) {
                label
                metricsRow
            }
        }
    }

    private var label: some View {
        Text(window.label)
            .font(.system(size: 12))
            .foregroundStyle(Color.white.opacity(0.55))
            .lineLimit(1)
    }

    @ViewBuilder
    private var metricsRow: some View {
        if window.showsProgressBar, let pct = window.usedPercent {
            ProgressBar(percent: pct, height: 6, width: 80)
            Text(Formatters.percent(pct))
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .foregroundStyle(percentColor(pct))
                .frame(width: 36, alignment: .trailing)
            if let reset = Formatters.resetLabel(
                resetsAt: window.resetsAt,
                resetsInSeconds: window.resetsInSeconds
            ) {
                Text(reset)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Color.white.opacity(0.38))
                    .lineLimit(1)
            }
        } else {
            Text(window.secondaryText ?? "—")
                .font(.system(size: 12))
                .foregroundStyle(Color.white.opacity(0.45))
                .lineLimit(2)
        }
    }
}

// MARK: - Window chrome / keep-on-top

/// Normal window chrome + optional floating “always on top”.
struct WindowConfigurator: NSViewRepresentable {
    var keepOnTop: Bool

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        DispatchQueue.main.async { configure(view.window) }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async { configure(nsView.window) }
    }

    private func configure(_ window: NSWindow?) {
        guard let window else { return }

        window.title = "tokmeter"
        window.titleVisibility = .visible
        window.titlebarAppearsTransparent = false
        window.isMovableByWindowBackground = true
        window.backgroundColor = NSColor(red: 0.09, green: 0.09, blue: 0.11, alpha: 1)
        window.styleMask.insert([.titled, .closable, .miniaturizable, .resizable])
        window.setContentSize(NSSize(width: max(window.frame.width, 360),
                                     height: max(window.frame.height, 280)))
        window.minSize = NSSize(width: 340, height: 220)

        if keepOnTop {
            window.level = .floating
            window.collectionBehavior.insert([.canJoinAllSpaces, .fullScreenAuxiliary])
        } else {
            window.level = .normal
            window.collectionBehavior.remove([.canJoinAllSpaces, .fullScreenAuxiliary])
        }
    }
}
