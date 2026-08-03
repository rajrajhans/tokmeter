import Foundation

enum TokmeterServiceError: LocalizedError {
    case binaryNotFound
    case timeout
    case nonZeroExit(code: Int32, stderr: String)
    case emptyOutput
    case decode(Error)

    var errorDescription: String? {
        switch self {
        case .binaryNotFound:
            return "tokmeter binary not found (set TOKMETER_BIN or install on PATH)"
        case .timeout:
            return "tokmeter timed out after 60s"
        case .nonZeroExit(let code, let stderr):
            let tail = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            if tail.isEmpty {
                return "tokmeter exited with code \(code)"
            }
            return "tokmeter exited \(code): \(tail)"
        case .emptyOutput:
            return "tokmeter returned empty output"
        case .decode(let err):
            return "Failed to parse tokmeter JSON: \(err.localizedDescription)"
        }
    }
}

enum TokmeterService {
    static let timeoutSeconds: TimeInterval = 60

    /// Resolve `tokmeter` binary path.
    static func resolveBinary() -> String? {
        if let override = ProcessInfo.processInfo.environment["TOKMETER_BIN"],
           !override.isEmpty,
           FileManager.default.isExecutableFile(atPath: override)
        {
            return override
        }

        let home = NSHomeDirectory()
        // Prefer repo `result/` / `~/.local` builds (may include newer `stats`)
        // over a stale home-manager/nix-profile install.
        let candidates: [String] = [
            "\(home)/.local/bin/tokmeter",
            FileManager.default.currentDirectoryPath + "/result/bin/tokmeter",
            FileManager.default.currentDirectoryPath + "/../result/bin/tokmeter",
            FileManager.default.currentDirectoryPath + "/../../result/bin/tokmeter",
            // Absolute monorepo path when HUD is launched from scripts/
            "\(home)/projects/tokmeter/result/bin/tokmeter",
            "\(home)/.nix-profile/bin/tokmeter",
            "/run/current-system/sw/bin/tokmeter",
            "/opt/homebrew/bin/tokmeter",
            "/usr/local/bin/tokmeter",
            Bundle.main.bundlePath + "/tokmeter",
        ]

        for path in candidates {
            if FileManager.default.isExecutableFile(atPath: path) {
                return path
            }
        }

        // PATH search
        if let pathEnv = ProcessInfo.processInfo.environment["PATH"] {
            for dir in pathEnv.split(separator: ":") {
                let path = "\(dir)/tokmeter"
                if FileManager.default.isExecutableFile(atPath: path) {
                    return path
                }
            }
        }

        // `which` fallback (inherits shell PATH when launched from terminal)
        if let which = which("tokmeter") {
            return which
        }

        return nil
    }

    private static func which(_ name: String) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        process.arguments = [name]
        let out = Pipe()
        process.standardOutput = out
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            let data = out.fileHandleForReading.readDataToEndOfFile()
            let path = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if let path, !path.isEmpty, FileManager.default.isExecutableFile(atPath: path) {
                return path
            }
        } catch {
            return nil
        }
        return nil
    }

    /// Run `tokmeter stats --json` (detailed) with fallback to `tokmeter --json`.
    static func fetch() async throws -> TokmeterPayload {
        try await Task.detached(priority: .userInitiated) {
            try runAndDecode()
        }.value
    }

    private static func runAndDecode() throws -> TokmeterPayload {
        guard let bin = resolveBinary() else {
            throw TokmeterServiceError.binaryNotFound
        }

        // Prefer detailed local stats; older installs only understand `--json`.
        do {
            return try runBinary(bin, arguments: ["stats", "--json"])
        } catch let err as TokmeterServiceError {
            if case .nonZeroExit(_, let stderr) = err,
               stderr.localizedCaseInsensitiveContains("unexpected argument")
                || stderr.localizedCaseInsensitiveContains("stats")
            {
                return try runBinary(bin, arguments: ["--json"])
            }
            throw err
        }
    }

    private static func runBinary(_ bin: String, arguments: [String]) throws -> TokmeterPayload {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: bin)
        process.arguments = arguments

        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr

        // Inherit a useful environment (NODE paths, etc.) but ensure PATH covers nix/homebrew.
        var env = ProcessInfo.processInfo.environment
        let extras = [
            "\(NSHomeDirectory())/.nix-profile/bin",
            "/run/current-system/sw/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "\(NSHomeDirectory())/.local/bin",
        ]
        let path = env["PATH"] ?? ""
        let merged = (extras + path.split(separator: ":").map(String.init))
            .reduce(into: [String]()) { acc, p in
                if !acc.contains(p) { acc.append(p) }
            }
            .joined(separator: ":")
        env["PATH"] = merged
        process.environment = env

        try process.run()

        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            process.waitUntilExit()
            group.leave()
        }

        let waitResult = group.wait(timeout: .now() + timeoutSeconds)
        if waitResult == .timedOut {
            process.terminate()
            throw TokmeterServiceError.timeout
        }

        let outData = stdout.fileHandleForReading.readDataToEndOfFile()
        let errData = stderr.fileHandleForReading.readDataToEndOfFile()
        let errText = String(data: errData, encoding: .utf8) ?? ""

        // Exit 0 = all ok; exit 2 = partial account failures but JSON still useful.
        // Only hard-fail when we have no parseable payload.
        if !outData.isEmpty {
            do {
                let decoder = JSONDecoder()
                return try decoder.decode(TokmeterPayload.self, from: outData)
            } catch {
                if process.terminationStatus != 0 {
                    throw TokmeterServiceError.nonZeroExit(
                        code: process.terminationStatus,
                        stderr: errText
                    )
                }
                throw TokmeterServiceError.decode(error)
            }
        }

        if process.terminationStatus != 0 {
            throw TokmeterServiceError.nonZeroExit(
                code: process.terminationStatus,
                stderr: errText
            )
        }

        throw TokmeterServiceError.emptyOutput
    }
}
