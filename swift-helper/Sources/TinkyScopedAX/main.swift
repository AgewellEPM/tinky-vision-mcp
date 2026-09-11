import Foundation
import Darwin
import ScopedAX

// A separate executable has no coordinate, keyboard, stream, or legacy-consent
// entry point. Protocol inspection never initializes NSApplication or AX.
let arguments = Array(CommandLine.arguments.dropFirst())
if arguments == ["--protocol-info"] {
    let descriptor: [String: Any] = [
        "schema_version": 1, "product": "tinky-os-scoped-ax", "protocol": "tinky.scoped-ax.v1",
        "operations": ["targets", "enroll", "snapshot", "press", "release"],
        "native_consent_required": true, "accepted": false, "hard_containment": false,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: descriptor, options: [.sortedKeys]) else { exit(70) }
    FileHandle.standardOutput.write(data + Data([10]))
} else if arguments.first == "scoped-ax" {
    MainActor.assumeIsolated { ScopedAXRuntime.run(arguments: Array(arguments.dropFirst())) }
} else if arguments == ["--help"] || arguments == ["-h"] {
    print("tinky-os-scoped-ax: --protocol-info | scoped-ax --session-id <uuid> [--read-only] [--deny-bundle <bundleID>]")
} else {
    FileHandle.standardError.write(Data("Unsupported scoped helper command.\n".utf8))
    exit(64)
}
