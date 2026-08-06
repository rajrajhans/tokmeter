import Foundation

// MARK: - JSON models (matches `tokmeter --json`)

struct TokmeterPayload: Codable, Sendable {
    var fetchedAt: String
    var accounts: [AccountSnapshot]
}

struct LocalStatsLine: Codable, Identifiable, Sendable {
    var label: String
    var value: String
    var id: String { label + value }
}

struct LocalStats: Codable, Sendable {
    var period: String?
    var source: String?
    var lines: [LocalStatsLine]
}

struct AccountSnapshot: Codable, Identifiable, Sendable {
    var provider: String
    var accountId: String
    var label: String
    var ok: Bool
    var plan: String?
    var error: String?
    var email: String?
    var source: String?
    var provenance: String?
    var windows: [UsageWindow]
    var local: LocalStats?
    var extras: JSONValue?
    var fetchedAt: String?

    var id: String { accountId }

    /// Short provider name for badges / donut captions.
    var providerName: String {
        switch provider.lowercased() {
        case "claude": return "Claude"
        case "codex": return "Codex"
        case "grok": return "Grok"
        default: return provider.capitalized
        }
    }

    /// Compact account tag: "max", "pro", "personal" — empty when redundant.
    var shortTag: String {
        if !label.isEmpty { return label }
        if let plan, !plan.isEmpty { return plan }
        return ""
    }

    /// Human title: "Claude · max · Max 20x" (never email).
    var displayTitle: String {
        var parts = [providerName]
        if !label.isEmpty { parts.append(label) }
        if let plan, !plan.isEmpty, plan.lowercased() != label.lowercased() {
            parts.append(plan)
        }
        return parts.joined(separator: " · ")
    }

    /// Quota windows worth glancing at — strips identity, local noise, off/zero credits.
    var glanceWindows: [UsageWindow] {
        windows.filter(\.isGlanceable)
    }

    /// Highest-utilization window (the number you care about first).
    var primaryWindow: UsageWindow? {
        glanceWindows
            .filter { $0.usedPercent != nil }
            .max { ($0.usedPercent ?? -1) < ($1.usedPercent ?? -1) }
    }

    var primaryPercent: Double? {
        primaryWindow?.usedPercent
    }
}

struct UsageWindow: Codable, Identifiable, Sendable {
    var id: String
    var label: String
    var usedPercent: Double?
    var resetsAt: String?
    var resetsInSeconds: Double?
    var extra: [String: JSONValue]?

    /// Short label for the HUD: "Session", "Weekly", "Fable", …
    var shortLabel: String {
        let raw = label.trimmingCharacters(in: .whitespacesAndNewlines)
        // "Weekly · All models" → "Weekly"
        // "Weekly · Fable" → "Fable"
        // "Current session" → "Session"
        // "Primary (7d)" → "Primary"
        // "Weekly credits" → "Weekly"
        if raw.localizedCaseInsensitiveContains("session") {
            return "Session"
        }
        if raw.localizedCaseInsensitiveContains("fable") {
            return "Fable"
        }
        if raw.hasPrefix("Weekly · ") {
            let rest = String(raw.dropFirst("Weekly · ".count))
            if rest.localizedCaseInsensitiveContains("all") {
                return "Weekly"
            }
            return rest
        }
        if raw.localizedCaseInsensitiveContains("weekly") {
            return "Weekly"
        }
        if raw.hasPrefix("Primary") {
            return "Primary"
        }
        if raw.localizedCaseInsensitiveContains("credit") {
            return "Credits"
        }
        // Fall back: first token, trim parenthetical
        let bare = raw.split(separator: "(").first.map(String.init) ?? raw
        return bare.trimmingCharacters(in: .whitespaces)
    }

    /// Whether this window belongs on a glanceable HUD.
    var isGlanceable: Bool {
        // Always show real utilization bars.
        if usedPercent != nil { return true }

        switch id {
        case "identity", "local", "billing":
            return false

        case "credits", "reset-credits":
            // Hide "off" and zero-balance noise — only show if money/credits matter.
            if let status = extra?["status"]?.stringValue, status == "off" {
                return false
            }
            if let unlimited = extra?["unlimited"]?.boolValue, unlimited {
                return true
            }
            if let bal = extra?["balance"] {
                switch bal {
                case .number(let n): return n > 0
                case .string(let s):
                    if let n = Double(s) { return n > 0 }
                    return !s.isEmpty && s != "0"
                default: break
                }
            }
            if let avail = extra?["available"] {
                switch avail {
                case .number(let n): return n > 0
                case .string(let s):
                    if let n = Double(s) { return n > 0 }
                    return !s.isEmpty && s != "0"
                default: break
                }
            }
            return false

        default:
            // Unknown non-percent rows are clutter in a HUD.
            return false
        }
    }

    /// Secondary text for non-bar windows (credits with balance, …).
    var secondaryText: String? {
        if usedPercent != nil { return nil }

        switch id {
        case "credits", "reset-credits":
            if let status = extra?["status"]?.stringValue, status == "off" {
                return "off"
            }
            if let unlimited = extra?["unlimited"]?.boolValue, unlimited {
                return "unlimited"
            }
            if let balance = extra?["balance"] {
                return balance.displayString
            }
            if let available = extra?["available"] {
                return available.displayString
            }
            return "—"

        default:
            break
        }

        if let status = extra?["status"]?.stringValue {
            return status
        }
        return nil
    }

    var showsProgressBar: Bool {
        usedPercent != nil
    }
}

// MARK: - Loose JSON value for `extra` / `extras`

enum JSONValue: Codable, Sendable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let v = try? c.decode(Bool.self) {
            self = .bool(v)
        } else if let v = try? c.decode(Double.self) {
            self = .number(v)
        } else if let v = try? c.decode(Int.self) {
            self = .number(Double(v))
        } else if let v = try? c.decode(String.self) {
            self = .string(v)
        } else if let v = try? c.decode([String: JSONValue].self) {
            self = .object(v)
        } else if let v = try? c.decode([JSONValue].self) {
            self = .array(v)
        } else {
            self = .null
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }

    var stringValue: String? {
        if case .string(let v) = self { return v }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let v) = self { return v }
        return nil
    }

    var intValue: Int? {
        if case .number(let v) = self { return Int(v) }
        return nil
    }

    var displayString: String {
        switch self {
        case .string(let v): return v
        case .number(let v):
            if v.rounded() == v { return String(Int(v)) }
            return String(v)
        case .bool(let v): return v ? "true" : "false"
        case .null: return "—"
        case .object, .array: return "…"
        }
    }
}

// MARK: - Formatting helpers

enum Formatters {
    static func percent(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return "\(Int(value.rounded()))%"
    }

    static func duration(seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "—" }
        let s = Int(seconds.rounded(.down))
        if s < 60 { return "\(s)s" }
        let m = s / 60
        if m < 60 {
            let rem = s % 60
            return rem > 0 ? "\(m)m \(rem)s" : "\(m)m"
        }
        let h = m / 60
        if h < 48 {
            let remM = m % 60
            return remM > 0 ? "\(h)h \(remM)m" : "\(h)h"
        }
        let d = h / 24
        let remH = h % 24
        return remH > 0 ? "\(d)d \(remH)h" : "\(d)d"
    }

    /// Compact reset label: "1h 8m" or "Thu 7:30".
    static func resetLabel(resetsAt: String?, resetsInSeconds: Double?) -> String? {
        var secs = resetsInSeconds
        if secs == nil, let resetsAt {
            secs = secondsUntil(iso: resetsAt)
        }
        guard let secs else { return nil }
        if secs <= 0 { return "due" }

        if secs < 48 * 3600 {
            return duration(seconds: secs)
        }
        if let resetsAt, let date = parseISO8601(resetsAt) {
            let df = DateFormatter()
            df.locale = Locale.current
            df.dateFormat = "EEE H:mm"
            return df.string(from: date)
        }
        return duration(seconds: secs)
    }

    static func headerTime(_ date: Date = Date()) -> String {
        let df = DateFormatter()
        df.locale = Locale.current
        df.dateFormat = "HH:mm"
        return df.string(from: date)
    }

    static func parseISO8601(_ string: String) -> Date? {
        let f1 = ISO8601DateFormatter()
        f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f1.date(from: string) { return d }
        let f2 = ISO8601DateFormatter()
        f2.formatOptions = [.withInternetDateTime]
        return f2.date(from: string)
    }

    static func secondsUntil(iso: String) -> Double? {
        guard let d = parseISO8601(iso) else { return nil }
        return d.timeIntervalSinceNow
    }
}
