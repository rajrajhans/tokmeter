import SwiftUI

// MARK: - Colors

enum UsageColor {
    /// Green <50%, amber <80%, red ≥80%.
    static func forPercent(_ percent: Double) -> Color {
        if percent < 50 { return Color(red: 0.28, green: 0.88, blue: 0.48) }
        if percent < 80 { return Color(red: 0.98, green: 0.78, blue: 0.18) }
        return Color(red: 0.98, green: 0.32, blue: 0.32)
    }

    static func forPercentOptional(_ percent: Double?) -> Color {
        guard let percent, percent.isFinite else { return Color.secondary }
        return forPercent(percent)
    }

    static func provider(_ name: String) -> Color {
        switch name.lowercased() {
        case "claude": return Color(red: 0.85, green: 0.52, blue: 0.28) // warm clay
        case "codex": return Color(red: 0.30, green: 0.78, blue: 0.72)  // teal
        case "grok": return Color(red: 0.55, green: 0.62, blue: 0.98)   // soft blue
        default: return Color.white.opacity(0.55)
        }
    }
}

/// Text color matching bar thresholds.
func percentColor(_ percent: Double?) -> Color {
    UsageColor.forPercentOptional(percent)
}

// MARK: - Thick horizontal usage bar (full-width)

/// Bold, full-width quota bar. Designed to read from across the room.
struct StackBar: View {
    var percent: Double
    var height: CGFloat = 14
    var showTrack: Bool = true

    private var clamped: Double {
        min(100, max(0, percent.isFinite ? percent : 0))
    }

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let fill = w * CGFloat(clamped / 100.0)
            ZStack(alignment: .leading) {
                if showTrack {
                    RoundedRectangle(cornerRadius: height / 2, style: .continuous)
                        .fill(Color.white.opacity(0.08))
                }
                RoundedRectangle(cornerRadius: height / 2, style: .continuous)
                    .fill(UsageColor.forPercent(clamped))
                    .frame(width: max(fill, clamped > 0 ? height * 0.6 : 0))
            }
        }
        .frame(height: height)
        .accessibilityLabel("\(Int(clamped.rounded())) percent used")
    }
}

/// Compact horizontal usage bar (legacy / tight spaces).
struct ProgressBar: View {
    var percent: Double
    var height: CGFloat = 6
    var width: CGFloat = 72

    var body: some View {
        StackBar(percent: percent, height: height)
            .frame(width: width)
    }
}

// MARK: - Donut / ring chart

/// Circular used/remaining ring. Big center % for glanceability.
struct UsageDonut: View {
    var percent: Double
    var size: CGFloat = 72
    var lineWidth: CGFloat = 8
    /// Optional accent under the ring (provider color).
    var accent: Color? = nil
    var centerLabel: String? = nil

    private var clamped: Double {
        min(100, max(0, percent.isFinite ? percent : 0))
    }

    private var fraction: CGFloat {
        CGFloat(clamped / 100.0)
    }

    var body: some View {
        ZStack {
            // Track
            Circle()
                .stroke(Color.white.opacity(0.10), lineWidth: lineWidth)

            // Used arc
            Circle()
                .trim(from: 0, to: fraction)
                .stroke(
                    UsageColor.forPercent(clamped),
                    style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))

            // Subtle provider accent ring outside
            if let accent {
                Circle()
                    .stroke(accent.opacity(0.35), lineWidth: 1.5)
                    .padding(-3)
            }

            VStack(spacing: 0) {
                Text("\(Int(clamped.rounded()))")
                    .font(.system(size: size * 0.28, weight: .bold, design: .rounded))
                    .foregroundStyle(UsageColor.forPercent(clamped))
                    .monospacedDigit()
                Text("%")
                    .font(.system(size: size * 0.12, weight: .semibold, design: .rounded))
                    .foregroundStyle(Color.white.opacity(0.4))
                    .offset(y: -2)
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel(centerLabel.map { "\($0): \(Int(clamped.rounded())) percent" }
            ?? "\(Int(clamped.rounded())) percent used")
    }
}

// MARK: - Multi-segment stack (share of whole, not %)

/// Horizontal stacked segments (e.g. model mix). Values are relative weights.
struct SegmentStackBar: View {
    struct Segment: Identifiable {
        var id: String { label + String(value) }
        var label: String
        var value: Double
        var color: Color
    }

    var segments: [Segment]
    var height: CGFloat = 10

    private var total: Double {
        max(segments.map(\.value).reduce(0, +), 0.0001)
    }

    var body: some View {
        GeometryReader { geo in
            HStack(spacing: 2) {
                ForEach(segments) { seg in
                    let w = geo.size.width * CGFloat(seg.value / total)
                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                        .fill(seg.color)
                        .frame(width: max(w, seg.value > 0 ? 3 : 0))
                }
            }
        }
        .frame(height: height)
        .clipShape(RoundedRectangle(cornerRadius: height / 2, style: .continuous))
        .background(
            RoundedRectangle(cornerRadius: height / 2, style: .continuous)
                .fill(Color.white.opacity(0.06))
        )
    }
}
