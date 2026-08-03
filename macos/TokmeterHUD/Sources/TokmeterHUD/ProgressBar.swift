import SwiftUI

/// Compact horizontal usage bar. Green <50%, yellow <80%, red ≥80%.
struct ProgressBar: View {
    var percent: Double
    var height: CGFloat = 6
    var width: CGFloat = 72

    private var clamped: Double {
        min(100, max(0, percent))
    }

    private var fillColor: Color {
        if clamped < 50 { return Color(red: 0.30, green: 0.85, blue: 0.40) }
        if clamped < 80 { return Color(red: 0.95, green: 0.80, blue: 0.20) }
        return Color(red: 0.95, green: 0.30, blue: 0.30)
    }

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let fill = w * CGFloat(clamped / 100.0)
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color.white.opacity(0.10))
                Capsule()
                    .fill(fillColor)
                    .frame(width: max(fill, clamped > 0 ? 2 : 0))
            }
        }
        .frame(width: width, height: height)
        .accessibilityLabel("\(Int(clamped.rounded())) percent used")
    }
}

/// Text color matching the bar thresholds.
func percentColor(_ percent: Double?) -> Color {
    guard let percent, percent.isFinite else {
        return Color.secondary
    }
    if percent < 50 { return Color(red: 0.30, green: 0.85, blue: 0.40) }
    if percent < 80 { return Color(red: 0.95, green: 0.80, blue: 0.20) }
    return Color(red: 0.95, green: 0.30, blue: 0.30)
}

