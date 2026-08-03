import Foundation

// MARK: - JSON models (matches `tokmeter --json`)

struct TokmeterPayload: Codable, Sendable {
    var fetchedAt: String
    var accounts: [AccountSnapshot]
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
    var extras: JSONValue?
    var fetchedAt: String?

    var id: String { accountId }

    /// Human title: "Claude · max · Max 20x" (never email).
    var displayTitle: String {
        let name: String
        switch provider.lowercased() {
        case "claude": name = "Claude"
        case "codex": name = "Codex"
        case "grok": name = "Grok"
        default: name = provider.capitalized
        }
        var parts = [name]
        if !label.isEmpty { parts.append(label) }
        if let plan, !plan.isEmpty, plan.lowercased() != label.lowercased() {
            parts.append(plan)
        }
        return parts.joined(separator: " · ")
    }
}

struct UsageWindow: Codable, Identifiable, Sendable {
    var id: String
    var label: String
    var usedPercent: Double?
    var resetsAt: String?
    var resetsInSeconds: Double?
    var extra: [String: JSONValue]?

    /// Secondary text for non-bar windows (credits off, identity, local, …).
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

        case "identity":
            let mode = extra?["mode"]?.stringValue ?? "oidc"
            let principal = extra?["principal"]?.stringValue ?? "User"
            return "\(mode) · \(principal)"

        case "local":
            let sessions = extra?["sessions"]?.intValue ?? 0
            let tokens = extra?["tokensLabel"]?.stringValue ?? "0"
            let days = extra?["windowDays"]?.intValue ?? 30
            return "\(sessions) sessions · ~\(tokens) tokens (\(days)d)"

        case "billing":
            if let status = extra?["status"]?.stringValue {
                if status == "unavailable" {
                    let note = extra?["note"]?.stringValue ?? "unavailable"
                    return "unavailable (\(note))"
                }
                if status == "received" {
                    return "received"
                }
            }
            return nil

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
