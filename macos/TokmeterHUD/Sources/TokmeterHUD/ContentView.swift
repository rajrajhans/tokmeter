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

    /// Accounts that have something glanceable (or an error worth showing).
    private var visibleAccounts: [AccountSnapshot] {
        model.accounts.filter { acc in
            !acc.ok || !acc.glanceWindows.isEmpty
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().opacity(0.25)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if let globalError = model.globalError, model.accounts.isEmpty {
                        errorBanner(globalError)
                    } else if model.accounts.isEmpty, !model.isLoading {
                        emptyState
                    } else {
                        // Layer 1 — extreme glance: donut rings
                        if !okAccountsWithPercent.isEmpty {
                            DonutOverview(accounts: okAccountsWithPercent)
                        }

                        // Layer 2 — thick bars per account
                        ForEach(visibleAccounts) { account in
                            AccountCard(account: account)
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
                .padding(.vertical, 14)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(minWidth: 360, idealWidth: 440, maxWidth: .infinity,
               minHeight: 280, idealHeight: 560, maxHeight: .infinity)
        .background(Color(red: 0.07, green: 0.07, blue: 0.09))
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

    private var okAccountsWithPercent: [AccountSnapshot] {
        visibleAccounts.filter { $0.ok && $0.primaryPercent != nil }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 10) {
            Text("tokmeter")
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .foregroundStyle(Color.white.opacity(0.88))

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
            .foregroundStyle(Color.white.opacity(0.7))
            .help("Refresh now")
            .disabled(model.isLoading)
            .keyboardShortcut("r", modifiers: [.command])

            Text(model.fetchedAt.map { Formatters.headerTime($0) } ?? "—")
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .foregroundStyle(Color.white.opacity(0.4))
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
            .foregroundStyle(Color.white.opacity(0.65))
            .help("Settings")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 9)
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

// MARK: - Donut overview (layer 1)

/// Row of provider rings — worst/highest limit per account. Pure glance layer.
struct DonutOverview: View {
    let accounts: [AccountSnapshot]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("AT A GLANCE")
                .font(.system(size: 10, weight: .bold, design: .rounded))
                .foregroundStyle(Color.white.opacity(0.35))
                .tracking(0.8)

            // Wrap when many accounts; stay one row when it fits.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 14) {
                    ForEach(accounts) { acc in
                        DonutCell(account: acc)
                    }
                }
                .frame(maxWidth: .infinity)

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 14) {
                        ForEach(accounts) { acc in
                            DonutCell(account: acc)
                        }
                    }
                }
            }
        }
        .padding(.bottom, 4)
    }
}

struct DonutCell: View {
    let account: AccountSnapshot

    private var pct: Double {
        account.primaryPercent ?? 0
    }

    private var metricLabel: String {
        account.primaryWindow?.shortLabel ?? "—"
    }

    var body: some View {
        VStack(spacing: 6) {
            UsageDonut(
                percent: pct,
                size: 68,
                lineWidth: 7,
                accent: UsageColor.provider(account.provider),
                centerLabel: account.displayTitle
            )

            VStack(spacing: 1) {
                Text(account.providerName)
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .foregroundStyle(Color.white.opacity(0.85))
                if !account.shortTag.isEmpty {
                    Text(account.shortTag)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(UsageColor.provider(account.provider).opacity(0.9))
                }
                Text(metricLabel)
                    .font(.system(size: 9, weight: .medium, design: .rounded))
                    .foregroundStyle(Color.white.opacity(0.35))
            }
            .lineLimit(1)
        }
        .frame(minWidth: 72)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Account card (layer 2)

struct AccountCard: View {
    let account: AccountSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Header row
            HStack(spacing: 8) {
                Circle()
                    .fill(UsageColor.provider(account.provider))
                    .frame(width: 7, height: 7)
                Text(account.displayTitle)
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .foregroundStyle(Color.white.opacity(0.9))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if account.ok, let pct = account.primaryPercent {
                    Text(Formatters.percent(pct))
                        .font(.system(size: 18, weight: .bold, design: .rounded))
                        .foregroundStyle(UsageColor.forPercent(pct))
                        .monospacedDigit()
                }
            }

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
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(account.glanceWindows) { window in
                        QuotaBarRow(window: window)
                    }
                }
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.white.opacity(0.035))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.white.opacity(0.06), lineWidth: 1)
        )
    }
}

// MARK: - Thick bar row

struct QuotaBarRow: View {
    let window: UsageWindow

    var body: some View {
        if window.showsProgressBar, let pct = window.usedPercent {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(window.shortLabel)
                        .font(.system(size: 11, weight: .medium, design: .rounded))
                        .foregroundStyle(Color.white.opacity(0.5))
                        .frame(width: 64, alignment: .leading)

                    Spacer(minLength: 4)

                    Text(Formatters.percent(pct))
                        .font(.system(size: 13, weight: .bold, design: .rounded))
                        .foregroundStyle(UsageColor.forPercent(pct))
                        .monospacedDigit()
                        .frame(minWidth: 36, alignment: .trailing)

                    if let reset = Formatters.resetLabel(
                        resetsAt: window.resetsAt,
                        resetsInSeconds: window.resetsInSeconds
                    ) {
                        Text(reset)
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                            .foregroundStyle(Color.white.opacity(0.32))
                            .frame(minWidth: 44, alignment: .trailing)
                    }
                }

                StackBar(percent: pct, height: 12)
            }
        } else if let text = window.secondaryText {
            // Rare: unlimited credits etc.
            HStack(spacing: 8) {
                Text(window.shortLabel)
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                    .foregroundStyle(Color.white.opacity(0.5))
                    .frame(width: 64, alignment: .leading)
                Text(text)
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .foregroundStyle(Color.cyan.opacity(0.85))
                Spacer(minLength: 0)
            }
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
        window.backgroundColor = NSColor(red: 0.07, green: 0.07, blue: 0.09, alpha: 1)
        window.styleMask.insert([.titled, .closable, .miniaturizable, .resizable])
        window.setContentSize(NSSize(width: max(window.frame.width, 380),
                                     height: max(window.frame.height, 300)))
        window.minSize = NSSize(width: 360, height: 260)

        if keepOnTop {
            window.level = .floating
            window.collectionBehavior.insert([.canJoinAllSpaces, .fullScreenAuxiliary])
        } else {
            window.level = .normal
            window.collectionBehavior.remove([.canJoinAllSpaces, .fullScreenAuxiliary])
        }
    }
}
