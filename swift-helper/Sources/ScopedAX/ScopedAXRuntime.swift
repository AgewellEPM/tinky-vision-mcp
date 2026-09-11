import AppKit
import Darwin
import Foundation

public enum ScopedAXRuntime {
    /// A private stdio child of one MCP server. EOF/death discards every in-memory grant.
    /// No sockets, persisted bearer handles, system permission prompts, or legacy flags.
    @MainActor public static func run(arguments: [String]) -> Never {
        var sessionID: String?
        var readOnly = false
        var denied = Set<String>()
        var index = 0
        while index < arguments.count {
            switch arguments[index] {
            case "--session-id":
                guard sessionID == nil, index + 1 < arguments.count,
                      let id = ScopedAXPolicy.token(arguments[index + 1]) else { exit(64) }
                sessionID = id; index += 2
            case "--read-only":
                guard !readOnly else { exit(64) }
                readOnly = true; index += 1
            case "--deny-bundle":
                guard index + 1 < arguments.count, denied.count < 128 else { exit(64) }
                let bundle = arguments[index + 1]
                guard !bundle.isEmpty, bundle.utf8.count <= 255,
                      bundle.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-").contains($0) }) else { exit(64) }
                denied.insert(bundle.lowercased()); index += 2
            default: exit(64)
            }
        }
        guard let sessionID else { exit(64) }
        signal(SIGPIPE, SIG_IGN)
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let backend = ScopedAXNativeBackend(deniedBundles: denied)
        let session = ScopedAXSession(sessionID: sessionID, backend: backend, readOnly: readOnly, deniedBundles: denied)
        // Read only one bounded request at a time. Waiting for its response prevents queued
        // stdin from reentering the main actor while NSAlert runs its nested modal loop.
        DispatchQueue.global(qos: .utility).async {
            var line = Data()
            var byte: UInt8 = 0
            while true {
                let count = Darwin.read(STDIN_FILENO, &byte, 1)
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { _exit(0) }
                if byte != 10 {
                    line.append(byte)
                    if line.count > ScopedAXPolicy.requestBytes { _exit(65) }
                    continue
                }
                let request = line; line.removeAll(keepingCapacity: true)
                let finished = DispatchSemaphore(value: 0)
                DispatchQueue.main.async {
                    let response = session.handle(request)
                    guard let data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]),
                          data.count <= ScopedAXPolicy.responseBytes else { _exit(70) }
                    var output = data; output.append(10)
                    let okay = output.withUnsafeBytes { bytes -> Bool in
                        var offset = 0
                        while offset < bytes.count {
                            let count = Darwin.write(STDOUT_FILENO, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                            if count < 0 && errno == EINTR { continue }
                            if count <= 0 { return false }
                            offset += count
                        }
                        return true
                    }
                    if !okay { _exit(74) }
                    finished.signal()
                }
                finished.wait()
            }
        }
        application.run()
        exit(0)
    }
}
