import Foundation
import CoreFoundation

/// This lane grants a small, local AXPress capability. It is not an execution receipt,
/// task acceptance oracle, or protection against a cooperating app changing its UI.
enum ScopedAXPolicy {
    static let requestBytes = 65_536
    static let responseBytes = 262_144
    static let lifetime: TimeInterval = 300
    static let candidateLifetime: TimeInterval = 60
    static let pressQuota = 8
    static let maximumRequests = 1_024
    static let maximumCandidates = 64
    static let maximumElements = 256
    static let protectedBundles: Set<String> = [
        "com.agilebits.onepassword7", "com.1password.1password",
        "com.1password.1password-launcher", "com.bitwarden.desktop",
        "com.lastpass.lastpassmacdesktop", "com.dashlane.dashlanephonefinal",
        "com.apple.keychainaccess", "com.apple.securityagent",
        "com.apple.localauthentication.uiagent", "com.apple.systempreferences",
        "com.apple.terminal", "com.googlecode.iterm2", "com.apple.screensharing",
        "com.apple.security.pboxd", "com.google.chrome", "org.chromium.chromium"
    ]
    static func token(_ value: Any?) -> String? {
        guard let text = value as? String, let uuid = UUID(uuidString: text),
              uuid.uuidString.lowercased() == text else { return nil }
        return text
    }
    static func integer(_ value: Any?, range: ClosedRange<Int>) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue >= Double(range.lowerBound),
              number.doubleValue <= Double(range.upperBound) else { return nil }
        return number.intValue
    }
    static func text(_ value: String, maximum: Int = 512) -> String {
        // App metadata and purpose are display-only, never executable instructions.
        String(value.unicodeScalars.filter {
            !CharacterSet.controlCharacters.contains($0) &&
            !CharacterSet(charactersIn: "\u{202A}\u{202B}\u{202C}\u{202D}\u{202E}\u{2066}\u{2067}\u{2068}\u{2069}").contains($0)
        }.prefix(maximum))
    }
}

struct ScopedAXIdentity: Equatable {
    let pid: Int32
    let birth: String
    let bundleID: String
    let appName: String
    let executablePath: String
    let executableSHA256: String
    let fileIdentity: String
    var wire: [String: Any] {
        ["pid": Int(pid), "process_start_unix_microseconds": birth,
         "bundle_id": bundleID, "executable_path": executablePath,
         "executable_sha256": executableSHA256]
    }
}

struct ScopedAXWindow {
    let key: String // Backend-private key retaining the actual AX object.
    let title: String
    let identity: ScopedAXIdentity
}

struct ScopedAXElement {
    let key: String
    let role: String
    let label: String
    let pressable: Bool
}

struct ScopedAXTree {
    let elements: [ScopedAXElement]
    let truncated: Bool
}

struct ScopedAXFailure: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

enum ScopedAXDispatch {
    case delivered
    case unknown
}

@MainActor
protocol ScopedAXBackend: AnyObject {
    func windows(pid: Int32) throws -> [ScopedAXWindow]
    func validate(window: ScopedAXWindow, requireFrontmost: Bool) throws
    func consent(window: ScopedAXWindow, purpose: String) -> Bool
    func snapshot(window: ScopedAXWindow) throws -> ScopedAXTree
    func validatePress(window: ScopedAXWindow, elementKey: String) throws
    func press(elementKey: String) -> ScopedAXDispatch
    func release()
}
