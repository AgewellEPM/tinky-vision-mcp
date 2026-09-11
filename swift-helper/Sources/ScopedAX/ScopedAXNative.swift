import AppKit
import ApplicationServices
import CryptoKit
import Darwin
import Foundation

enum ScopedAXProcessIdentity {
    static func read(_ pid: Int32, now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) throws -> ScopedAXIdentity {
        let deadline = now() + 2
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard pid > 0, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
              info.pbi_pid == UInt32(pid), info.pbi_start_tvsec > 0, info.pbi_start_tvusec < 1_000_000 else {
            throw ScopedAXFailure("identity_unavailable", "The kernel process birth identity is unavailable.")
        }
        let seconds = info.pbi_start_tvsec.multipliedReportingOverflow(by: 1_000_000)
        let birth = seconds.partialValue.addingReportingOverflow(info.pbi_start_tvusec)
        guard !seconds.overflow, !birth.overflow else { throw ScopedAXFailure("identity_unavailable", "Invalid process birth identity.") }
        var pathBytes = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let length = proc_pidpath(pid, &pathBytes, UInt32(pathBytes.count))
        guard length > 0, let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
              let bundle = app.bundleIdentifier, !bundle.isEmpty else {
            throw ScopedAXFailure("identity_unavailable", "A running application with a bundle identity is required.")
        }
        let rawPath = String(cString: pathBytes)
        guard let resolved = realpath(rawPath, nil) else { throw ScopedAXFailure("identity_unavailable", "The executable path cannot be resolved.") }
        let path = String(cString: resolved); free(resolved)
        guard app.executableURL?.resolvingSymlinksInPath().path == path else {
            throw ScopedAXFailure("identity_changed", "The kernel and application executable identities do not match.")
        }
        let descriptor = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw ScopedAXFailure("identity_unavailable", "The executable cannot be inspected safely.") }
        defer { close(descriptor) }
        var before = stat()
        guard fstat(descriptor, &before) == 0, before.st_mode & S_IFMT == S_IFREG,
              before.st_size > 0, before.st_size <= 268_435_456 else {
            throw ScopedAXFailure("identity_unavailable", "The executable is not a bounded regular file.")
        }
        var hasher = SHA256()
        var buffer = [UInt8](repeating: 0, count: 65_536)
        var readBytes = 0
        while true {
            guard now() < deadline else { throw ScopedAXFailure("identity_timeout", "Executable identity inspection exceeded its deadline.") }
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw ScopedAXFailure("identity_unavailable", "Executable inspection failed.") }
            if count == 0 { break }
            readBytes += count
            guard readBytes <= before.st_size else { throw ScopedAXFailure("identity_changed", "Executable changed during inspection.") }
            hasher.update(data: Data(buffer.prefix(count)))
        }
        var after = stat()
        guard fstat(descriptor, &after) == 0, readBytes == before.st_size,
              fileIdentity(before) == fileIdentity(after) else {
            throw ScopedAXFailure("identity_changed", "Executable changed during inspection.")
        }
        var finalInfo = proc_bsdinfo()
        var finalPath = [CChar](repeating: 0, count: pathBytes.count)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &finalInfo, size) == size,
              finalInfo.pbi_start_tvsec == info.pbi_start_tvsec,
              finalInfo.pbi_start_tvusec == info.pbi_start_tvusec,
              proc_pidpath(pid, &finalPath, UInt32(finalPath.count)) > 0,
              String(cString: finalPath) == rawPath else {
            throw ScopedAXFailure("identity_changed", "The process changed during executable inspection.")
        }
        return ScopedAXIdentity(pid: pid, birth: String(birth.partialValue), bundleID: bundle,
            appName: app.localizedName ?? bundle, executablePath: path,
            executableSHA256: hasher.finalize().map { String(format: "%02x", $0) }.joined(),
            fileIdentity: fileIdentity(after))
    }

    private static func fileIdentity(_ value: stat) -> String {
        "\(value.st_dev):\(value.st_ino):\(value.st_size):\(value.st_mtimespec.tv_sec):\(value.st_mtimespec.tv_nsec):\(value.st_ctimespec.tv_sec):\(value.st_ctimespec.tv_nsec)"
    }
}

@MainActor
final class ScopedAXNativeBackend: ScopedAXBackend {
    private let deniedBundles: Set<String>
    private var windowsByKey: [String: AXUIElement] = [:]
    private var elementsByKey: [String: RetainedElement] = [:]
    private struct RetainedElement {
        let element: AXUIElement
        let fingerprint: String
    }
    init(deniedBundles: Set<String>) {
        self.deniedBundles = ScopedAXPolicy.protectedBundles.union(deniedBundles.map { $0.lowercased() })
    }

    func windows(pid: Int32) throws -> [ScopedAXWindow] {
        try accessibility()
        release()
        let identity = try ScopedAXProcessIdentity.read(pid)
        try allowed(identity.bundleID)
        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, 0.25)
        let observed = try array(application, kAXWindowsAttribute)
        var rows: [ScopedAXWindow] = []
        for window in observed.prefix(ScopedAXPolicy.maximumCandidates) {
            try belongs(window, pid: pid)
            AXUIElementSetMessagingTimeout(window, 0.25)
            let key = UUID().uuidString.lowercased()
            windowsByKey[key] = window
            rows.append(ScopedAXWindow(key: key, title: string(window, kAXTitleAttribute), identity: identity))
        }
        return rows
    }

    func validate(window: ScopedAXWindow, requireFrontmost: Bool) throws {
        try accessibility()
        try allowed(window.identity.bundleID)
        guard let frontmost = NSWorkspace.shared.frontmostApplication else {
            throw ScopedAXFailure("focus_unavailable", "The foreground application cannot be validated.")
        }
        // A plain CLI helper may have no bundle ID while its own native consent panel
        // owns focus. This exception is read/revalidation only, never an AXPress grant.
        if requireFrontmost || frontmost.processIdentifier != getpid() {
            guard let frontBundle = frontmost.bundleIdentifier else {
                throw ScopedAXFailure("focus_unavailable", "The foreground application cannot be validated.")
            }
            try allowed(frontBundle)
        }
        if requireFrontmost && frontmost.processIdentifier != window.identity.pid {
            throw ScopedAXFailure("target_not_frontmost", "Bring the enrolled application to the foreground before continuing.")
        }
        guard try ScopedAXProcessIdentity.read(window.identity.pid) == window.identity else {
            throw ScopedAXFailure("identity_changed", "The enrolled process or executable identity has changed.")
        }
        guard let retained = windowsByKey[window.key] else { throw ScopedAXFailure("window_expired", "The native window reference has expired.") }
        try belongs(retained, pid: window.identity.pid)
        let app = AXUIElementCreateApplication(window.identity.pid)
        AXUIElementSetMessagingTimeout(app, 0.25)
        guard try array(app, kAXWindowsAttribute).prefix(ScopedAXPolicy.maximumCandidates).contains(where: { CFEqual($0, retained) }) else {
            throw ScopedAXFailure("window_changed", "The enrolled window is no longer present in the target application.")
        }
    }

    func consent(window: ScopedAXWindow, purpose: String) -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Allow bounded control of this window?"
        alert.informativeText = "Observed app: \(ScopedAXPolicy.text(window.identity.appName))\nBundle: \(ScopedAXPolicy.text(window.identity.bundleID))\nWindow: \(ScopedAXPolicy.text(window.title))\nExecutable: \(ScopedAXPolicy.text(window.identity.executablePath, maximum: 1_024))\nSHA-256: \(window.identity.executableSHA256)\nProcess: \(window.identity.pid), birth \(window.identity.birth)\n\nRequested purpose (untrusted): \(purpose)\n\nAllow at most 8 AXPress actions in this one window for 5 minutes. This grants no typing, coordinates, shell access, or other windows. Deny is the default."
        alert.addButton(withTitle: "Deny").keyEquivalent = "\r"
        alert.addButton(withTitle: "Allow up to 8 presses").keyEquivalent = ""
        // Native consent is independent of environment flags and legacy approval caches.
        let timer = Timer(timeInterval: 60, repeats: false) { _ in NSApplication.shared.abortModal() }
        RunLoop.main.add(timer, forMode: .common)
        defer { timer.invalidate(); alert.window.orderOut(nil) }
        let answer = alert.runModal()
        return answer == .alertSecondButtonReturn
    }

    func snapshot(window: ScopedAXWindow) throws -> ScopedAXTree {
        guard let root = windowsByKey[window.key] else { throw ScopedAXFailure("window_expired", "The native window reference has expired.") }
        elementsByKey.removeAll()
        let deadline = ProcessInfo.processInfo.systemUptime + 2
        var pending: [(AXUIElement, Int)] = [(root, 0)]
        var visited: [AXUIElement] = []
        var rows: [ScopedAXElement] = []
        var truncated = false
        while !pending.isEmpty {
            guard ProcessInfo.processInfo.systemUptime < deadline, rows.count < ScopedAXPolicy.maximumElements else { truncated = true; break }
            let (element, depth) = pending.removeFirst()
            if visited.contains(where: { CFEqual($0, element) }) { continue }
            visited.append(element)
            AXUIElementSetMessagingTimeout(element, 0.1)
            try belongs(element, pid: window.identity.pid)
            guard isInWindow(element, window: root) else { continue }
            let role = string(element, kAXRoleAttribute)
            let subrole = string(element, kAXSubroleAttribute)
            // Do not read AXValue or expose secure text or its subtree.
            if subrole == kAXSecureTextFieldSubrole as String || role.lowercased().contains("secure") { continue }
            let label = string(element, kAXTitleAttribute).isEmpty ? string(element, kAXDescriptionAttribute) : string(element, kAXTitleAttribute)
            let key = UUID().uuidString.lowercased()
            let observedFingerprint = fingerprint(element)
            let pressable = !role.isEmpty && observedFingerprint != nil && enabled(element) && supportsPress(element)
            if let observedFingerprint {
                elementsByKey[key] = RetainedElement(element: element, fingerprint: observedFingerprint)
            }
            rows.append(ScopedAXElement(key: key, role: role, label: label, pressable: pressable))
            if depth < 8 {
                let children = (try? array(element, kAXChildrenAttribute)) ?? []
                let remaining = max(0, ScopedAXPolicy.maximumElements - pending.count)
                if children.count > remaining { truncated = true }
                pending.append(contentsOf: children.prefix(remaining).map { ($0, depth + 1) })
            } else if !((try? array(element, kAXChildrenAttribute)) ?? []).isEmpty { truncated = true }
        }
        return ScopedAXTree(elements: rows, truncated: truncated)
    }

    func validatePress(window: ScopedAXWindow, elementKey: String) throws {
        guard let retained = elementsByKey[elementKey], let root = windowsByKey[window.key] else {
            throw ScopedAXFailure("stale_element", "The retained native element has expired.")
        }
        try belongs(retained.element, pid: window.identity.pid)
        guard isInWindow(retained.element, window: root), fingerprint(retained.element) == retained.fingerprint,
              enabled(retained.element), supportsPress(retained.element) else {
            throw ScopedAXFailure("element_changed", "The target element changed, was disabled, or no longer supports AXPress.")
        }
        // Verify the exact window is focused, not merely another window in the same app.
        let application = AXUIElementCreateApplication(window.identity.pid)
        AXUIElementSetMessagingTimeout(application, 0.1)
        guard let focused = attribute(application, kAXFocusedWindowAttribute),
              CFGetTypeID(focused) == AXUIElementGetTypeID(), CFEqual(focused, root) else {
            throw ScopedAXFailure("window_not_focused", "The enrolled window must be the focused window of its application.")
        }
    }

    func press(elementKey: String) -> ScopedAXDispatch {
        guard let retained = elementsByKey[elementKey] else { return .unknown }
        // This is the only mutation in the scoped lane. There is no CGEvent/coordinate fallback.
        let result = AXUIElementPerformAction(retained.element, kAXPressAction as CFString)
        elementsByKey.removeAll()
        return result == .success ? .delivered : .unknown
    }

    func release() { windowsByKey.removeAll(); elementsByKey.removeAll() }

    private func accessibility() throws {
        guard AXIsProcessTrusted() else { throw ScopedAXFailure("accessibility_unavailable", "Accessibility permission must already be granted. This lane does not request system permission.") }
    }
    private func allowed(_ bundle: String) throws {
        guard !bundle.isEmpty, !deniedBundles.contains(bundle.lowercased()) else { throw ScopedAXFailure("protected_app", "A protected application cannot be controlled by this lane.") }
    }
    private func belongs(_ element: AXUIElement, pid: Int32) throws {
        var observed: pid_t = 0
        guard AXUIElementGetPid(element, &observed) == .success, observed == pid else {
            throw ScopedAXFailure("element_process_changed", "The native element does not belong to the enrolled process.")
        }
    }
    private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }
    private func string(_ element: AXUIElement, _ name: String) -> String {
        guard let value = attribute(element, name), CFGetTypeID(value) == CFStringGetTypeID() else { return "" }
        return ScopedAXPolicy.text(value as! String, maximum: 1_024)
    }
    private func array(_ element: AXUIElement, _ name: String) throws -> [AXUIElement] {
        // Count first; never request an unbounded AX array from another process.
        var count: CFIndex = 0
        guard AXUIElementGetAttributeValueCount(element, name as CFString, &count) == .success, count >= 0 else {
            throw ScopedAXFailure("ax_unavailable", "The application did not provide the requested AX collection.")
        }
        if count == 0 { return [] }
        var values: CFArray?
        guard AXUIElementCopyAttributeValues(element, name as CFString, 0, min(count, 257), &values) == .success,
              let raw = values as? [AnyObject], raw.allSatisfy({ CFGetTypeID($0) == AXUIElementGetTypeID() }) else {
            throw ScopedAXFailure("ax_unavailable", "The application returned an invalid AX collection.")
        }
        return raw.map { $0 as! AXUIElement }
    }
    private func enabled(_ element: AXUIElement) -> Bool {
        guard let value = attribute(element, kAXEnabledAttribute), CFGetTypeID(value) == CFBooleanGetTypeID() else { return false }
        return CFBooleanGetValue((value as! CFBoolean))
    }
    private func supportsPress(_ element: AXUIElement) -> Bool {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success, let actions = names as? [String], actions.count <= 32 else { return false }
        return actions.contains(kAXPressAction as String)
    }
    private func isInWindow(_ element: AXUIElement, window: AXUIElement) -> Bool {
        if CFEqual(element, window) { return true }
        guard let owner = attribute(element, kAXWindowAttribute), CFGetTypeID(owner) == AXUIElementGetTypeID() else { return false }
        return CFEqual(owner, window)
    }
    private func fingerprint(_ element: AXUIElement) -> String? {
        let fields = [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXIdentifierAttribute]
        var fingerprint = ""
        for name in fields {
            var value: CFTypeRef?
            let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
            if result == .attributeUnsupported || result == .noValue {
                // Unsupported and empty are distinct, including at final revalidation.
                fingerprint += "a;"
                continue
            }
            guard result == .success, let value, CFGetTypeID(value) == CFStringGetTypeID() else { return nil }
            let text = value as! String
            // Do not truncate a semantic fingerprint: suffix-only changes must invalidate it.
            guard text.utf8.count <= 4_096 else { return nil }
            fingerprint += "\(text.utf8.count):\(text);"
        }
        return fingerprint
    }
}
