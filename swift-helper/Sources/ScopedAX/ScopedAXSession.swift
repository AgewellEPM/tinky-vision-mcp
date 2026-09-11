import Foundation

/// All validation, quota reservation and dispatch run synchronously on the main actor.
/// Runtime stdin serializes requests; this class also rejects modal-loop reentrancy.
@MainActor
final class ScopedAXSession {
    let sessionID: String
    private let backend: ScopedAXBackend
    private let readOnly: Bool
    private let deniedBundles: Set<String>
    private let clock: () -> TimeInterval
    private var seenRequests = Set<String>()
    private var seenActions = Set<String>()
    private var deniedIdentities = Set<String>()
    private var candidates: [String: (ScopedAXWindow, TimeInterval)] = [:]
    private var grant: Grant?
    private var busy = false
    private var uncertain = false
    private struct Grant {
        let handle: String
        let window: ScopedAXWindow
        let expires: TimeInterval
        var remaining = ScopedAXPolicy.pressQuota
        var generation = 0
        var elements: [String: ScopedAXElement] = [:]
    }

    init(sessionID: String, backend: ScopedAXBackend, readOnly: Bool = false,
         deniedBundles: Set<String> = [], clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.sessionID = sessionID
        self.backend = backend
        self.readOnly = readOnly
        self.deniedBundles = ScopedAXPolicy.protectedBundles.union(deniedBundles.map { $0.lowercased() })
        self.clock = clock
    }

    func handle(_ data: Data) -> [String: Any] {
        var requestID = ""
        var operation = ""
        func response(_ disposition: String, _ code: String, _ message: String, _ extras: [String: Any] = [:]) -> [String: Any] {
            var result: [String: Any] = ["schema_version": 1, "request_id": requestID,
                "session_id": sessionID, "operation": operation, "disposition": disposition,
                "code": code, "message": message, "accepted": false]
            for (key, value) in extras { result[key] = value }
            return result
        }
        do {
            guard data.count <= ScopedAXPolicy.requestBytes,
                  let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(object.keys) == ["schema_version", "request_id", "operation", "arguments"],
                  ScopedAXPolicy.integer(object["schema_version"], range: 1...1) != nil,
                  let id = ScopedAXPolicy.token(object["request_id"]),
                  let op = object["operation"] as? String,
                  let arguments = object["arguments"] as? [String: Any] else {
                throw ScopedAXFailure("invalid_request", "Expected a bounded schema-1 request with closed fields.")
            }
            requestID = id; operation = op
            guard !busy else { throw ScopedAXFailure("busy", "A native consent or operation is already in progress.") }
            guard !seenRequests.contains(id) else { throw ScopedAXFailure("request_replayed", "Request IDs are single use.") }
            guard seenRequests.count < ScopedAXPolicy.maximumRequests else {
                revoke(); throw ScopedAXFailure("session_exhausted", "Start a new connection and obtain fresh native consent.")
            }
            seenRequests.insert(id)
            busy = true
            defer { busy = false }
            if op == "release" {
                try keys(arguments, ["target_handle"])
                let handle = try requiredToken(arguments, "target_handle")
                guard grant?.handle == handle else { throw ScopedAXFailure("unknown_target", "Target handle does not belong to this session.") }
                revoke()
                return response("observed", "released", "The enrollment has been revoked.", ["released": true])
            }
            guard !uncertain else { throw ScopedAXFailure("session_unknown", "A dispatched action has an unknown outcome. This connection cannot dispatch again.") }
            switch op {
            case "targets":
                try keys(arguments, ["pid"])
                guard let pid = ScopedAXPolicy.integer(arguments["pid"], range: 1...Int(Int32.max)) else {
                    throw ScopedAXFailure("invalid_pid", "A positive process ID is required.")
                }
                guard grant == nil else { throw ScopedAXFailure("target_active", "Release the current enrollment before selecting another window.") }
                candidates.removeAll()
                let windows = try backend.windows(pid: Int32(pid))
                var rows: [[String: Any]] = []
                for window in windows.prefix(ScopedAXPolicy.maximumCandidates) {
                    try allowed(window)
                    let token = UUID().uuidString.lowercased()
                    candidates[token] = (window, clock() + ScopedAXPolicy.candidateLifetime)
                    rows.append(["window_token": token, "pid": Int(window.identity.pid),
                        "bundle_id": window.identity.bundleID, "app_name": ScopedAXPolicy.text(window.identity.appName),
                        "window_title": ScopedAXPolicy.text(window.title), "executable_sha256": window.identity.executableSHA256])
                }
                return response("observed", "targets_observed", "Window candidates are observations; enrollment requires native consent.", ["targets": rows])
            case "enroll":
                try keys(arguments, ["window_token", "purpose"])
                guard !readOnly else { throw ScopedAXFailure("read_only", "Enrollment is unavailable in read-only mode.") }
                guard grant == nil else { throw ScopedAXFailure("target_active", "Only one enrolled window is allowed.") }
                let token = try requiredToken(arguments, "window_token")
                guard let purpose = arguments["purpose"] as? String, !purpose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      purpose.utf8.count <= 1_024 else { throw ScopedAXFailure("invalid_purpose", "A short display-only purpose is required.") }
                guard let (window, expiry) = candidates[token], clock() < expiry else {
                    throw ScopedAXFailure("candidate_expired", "Select a fresh window candidate.")
                }
                try allowed(window)
                let identityKey = "\(window.identity.pid):\(window.identity.birth):\(window.identity.executableSHA256)"
                guard !deniedIdentities.contains(identityKey) else { throw ScopedAXFailure("consent_denied", "Native consent was denied for this app in this connection.") }
                try backend.validate(window: window, requireFrontmost: true)
                // Consume the candidate before opening a modal prompt; never auto-retry it.
                candidates.removeAll()
                guard backend.consent(window: window, purpose: ScopedAXPolicy.text(purpose, maximum: 800)) else {
                    deniedIdentities.insert(identityKey)
                    throw ScopedAXFailure("consent_denied", "Native consent was denied or expired.")
                }
                // NSAlert pumps its own event loop. Recheck the complete observed identity afterward.
                // The consent panel can temporarily own focus. Revalidate the target here;
                // AXPress separately requires the exact target window to regain focus.
                try backend.validate(window: window, requireFrontmost: false)
                try allowed(window)
                let handle = UUID().uuidString.lowercased()
                grant = Grant(handle: handle, window: window, expires: clock() + ScopedAXPolicy.lifetime)
                var identity = window.identity.wire
                identity["window_title"] = ScopedAXPolicy.text(window.title)
                return response("observed", "enrolled", "Native consent granted a bounded AXPress enrollment.",
                    ["target_handle": handle, "expires_in_seconds": Int(ScopedAXPolicy.lifetime),
                     "remaining_presses": ScopedAXPolicy.pressQuota, "identity": identity])
            case "snapshot":
                try keys(arguments, ["target_handle"])
                var current = try active(arguments)
                try backend.validate(window: current.window, requireFrontmost: true)
                // Invalidate the previous tokens even if the replacement snapshot fails.
                current.generation += 1; current.elements.removeAll(); grant = current
                let tree = try backend.snapshot(window: current.window)
                var rows: [[String: Any]] = []
                for item in tree.elements.prefix(ScopedAXPolicy.maximumElements) {
                    let token = UUID().uuidString.lowercased()
                    current.elements[token] = item
                    rows.append(["element_token": token, "role": ScopedAXPolicy.text(item.role, maximum: 100),
                                 "label": ScopedAXPolicy.text(item.label), "pressable": item.pressable])
                }
                grant = current
                return response("observed", "snapshot_observed", "Element tokens expire on the next snapshot or dispatch.",
                    ["target_handle": current.handle, "tree_generation": current.generation,
                     "elements": rows, "truncated": tree.truncated || tree.elements.count > ScopedAXPolicy.maximumElements])
            case "press":
                try keys(arguments, ["target_handle", "tree_generation", "element_token", "action_id"])
                guard !readOnly else { throw ScopedAXFailure("read_only", "AXPress is unavailable in read-only mode.") }
                let action = try requiredToken(arguments, "action_id")
                guard !seenActions.contains(action) else { throw ScopedAXFailure("action_replayed", "Action IDs are single use, including unknown outcomes.") }
                var current = try active(arguments)
                guard current.remaining > 0 else { throw ScopedAXFailure("quota_exhausted", "The native press quota has been exhausted.") }
                guard let generation = ScopedAXPolicy.integer(arguments["tree_generation"], range: 1...1_000_000), generation == current.generation,
                      let element = current.elements[try requiredToken(arguments, "element_token")], element.pressable else {
                    throw ScopedAXFailure("stale_element", "A current pressable element token and tree generation are required.")
                }
                try allowed(current.window)
                try backend.validate(window: current.window, requireFrontmost: true)
                try backend.validatePress(window: current.window, elementKey: element.key)
                guard clock() < current.expires else { revoke(); throw ScopedAXFailure("target_expired", "Native consent has expired.") }
                // Reserve before the only mutation. No await, event loop, or fallback occurs here.
                seenActions.insert(action); current.remaining -= 1
                current.elements.removeAll(); current.generation += 1; grant = current
                let result = backend.press(elementKey: element.key)
                let extras: [String: Any] = ["action_id": action, "target_handle": current.handle,
                    "tree_generation": current.generation, "remaining_presses": current.remaining,
                    "dispatch_observed": result == .delivered]
                if result == .delivered {
                    return response("observed", "axpress_dispatched", "AXPress returned success. The resulting application effect has not been verified.", extras)
                }
                uncertain = true; revoke()
                return response("unknown", "axpress_unknown", "AXPress did not return a confirmed dispatch. Do not replay; inspect the application separately.", extras)
            default:
                throw ScopedAXFailure("unknown_operation", "This lane supports only targets, enroll, snapshot, press and release.")
            }
        } catch let error as ScopedAXFailure {
            return response("denied", error.code, error.message)
        } catch {
            return response("denied", "observation_unavailable", "The requested native observation could not be validated.")
        }
    }

    private func allowed(_ window: ScopedAXWindow) throws {
        guard !window.identity.bundleID.isEmpty, !deniedBundles.contains(window.identity.bundleID.lowercased()) else {
            throw ScopedAXFailure("protected_app", "This app is protected from the scoped AX lane.")
        }
    }
    private func keys(_ args: [String: Any], _ expected: Set<String>) throws {
        guard Set(args.keys) == expected else { throw ScopedAXFailure("invalid_arguments", "Unexpected or missing argument fields.") }
    }
    private func requiredToken(_ args: [String: Any], _ name: String) throws -> String {
        guard let token = ScopedAXPolicy.token(args[name]) else { throw ScopedAXFailure("invalid_token", "Expected an opaque token from this native session.") }
        return token
    }
    private func active(_ args: [String: Any]) throws -> Grant {
        let handle = try requiredToken(args, "target_handle")
        guard let current = grant, current.handle == handle else { throw ScopedAXFailure("unknown_target", "Target handle does not belong to this session.") }
        guard clock() < current.expires else { revoke(); throw ScopedAXFailure("target_expired", "Native consent has expired.") }
        return current
    }
    private func revoke() { grant = nil; candidates.removeAll(); backend.release() }
}
