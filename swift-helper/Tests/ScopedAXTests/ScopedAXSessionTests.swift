import Foundation
import XCTest
@testable import ScopedAX

@MainActor
private final class FakeBackend: ScopedAXBackend {
    var identity = ScopedAXIdentity(pid: 123, birth: "123456789", bundleID: "example.fixture", appName: "Fixture",
        executablePath: "/Fixture.app/Contents/MacOS/Fixture", executableSHA256: String(repeating: "a", count: 64), fileIdentity: "1:2:3")
    var allowConsent = true
    var consentCalls = 0
    var validations = 0
    var failValidationAt: Int?
    var pressValidationFails = false
    var pressed = 0
    var dispatch = ScopedAXDispatch.delivered
    var released = 0
    var elementCount = 1
    var now: TimeInterval = 100
    func windows(pid: Int32) throws -> [ScopedAXWindow] { [ScopedAXWindow(key: "native-window", title: "Fixture window", identity: identity)] }
    func validate(window: ScopedAXWindow, requireFrontmost: Bool) throws {
        validations += 1
        if failValidationAt == validations { throw ScopedAXFailure("identity_changed", "Fixture identity changed.") }
    }
    func consent(window: ScopedAXWindow, purpose: String) -> Bool { consentCalls += 1; return allowConsent }
    func snapshot(window: ScopedAXWindow) throws -> ScopedAXTree {
        ScopedAXTree(elements: (0..<elementCount).map { ScopedAXElement(key: "native-element-\($0)", role: "AXButton", label: "Fixture button", pressable: true) }, truncated: false)
    }
    func validatePress(window: ScopedAXWindow, elementKey: String) throws {
        if pressValidationFails { throw ScopedAXFailure("element_changed", "Fixture element changed.") }
    }
    func press(elementKey: String) -> ScopedAXDispatch { pressed += 1; return dispatch }
    func release() { released += 1 }
}

@MainActor
final class ScopedAXSessionTests: XCTestCase {
    private func request(_ session: ScopedAXSession, _ operation: String, _ arguments: [String: Any], id: String = UUID().uuidString.lowercased()) throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: ["schema_version": 1, "request_id": id, "operation": operation, "arguments": arguments])
        return session.handle(data)
    }
    private func session(_ backend: FakeBackend, readOnly: Bool = false, deny: Set<String> = []) -> ScopedAXSession {
        ScopedAXSession(sessionID: UUID().uuidString.lowercased(), backend: backend, readOnly: readOnly, deniedBundles: deny, clock: { backend.now })
    }
    private func candidate(_ session: ScopedAXSession) throws -> String {
        let response = try request(session, "targets", ["pid": 123])
        return try XCTUnwrap((response["targets"] as? [[String: Any]])?.first?["window_token"] as? String)
    }
    private func enroll(_ session: ScopedAXSession) throws -> String {
        let result = try request(session, "enroll", ["window_token": candidate(session), "purpose": "Test the fixture button"])
        return try XCTUnwrap(result["target_handle"] as? String)
    }
    private func pressArguments(_ session: ScopedAXSession, handle: String, action: String = UUID().uuidString.lowercased()) throws -> [String: Any] {
        let snapshot = try request(session, "snapshot", ["target_handle": handle])
        return ["target_handle": handle, "tree_generation": try XCTUnwrap(snapshot["tree_generation"] as? Int),
            "element_token": try XCTUnwrap((snapshot["elements"] as? [[String: Any]])?.first?["element_token"] as? String), "action_id": action]
    }

    func testOnePressReturnsOnlyDispatchObservation() async throws {
        let backend = FakeBackend(); let state = session(backend)
        let handle = try enroll(state)
        let result = try request(state, "press", pressArguments(state, handle: handle))
        XCTAssertEqual(result["code"] as? String, "axpress_dispatched")
        XCTAssertEqual(result["accepted"] as? Bool, false)
        XCTAssertEqual(result["dispatch_observed"] as? Bool, true)
        XCTAssertEqual(result["remaining_presses"] as? Int, 7)
        XCTAssertEqual(backend.pressed, 1)
        XCTAssertEqual(backend.consentCalls, 1)
    }
    func testDenyIsLatchedAcrossFreshCandidates() async throws {
        let backend = FakeBackend(); backend.allowConsent = false; let state = session(backend)
        for _ in 0..<2 {
            let result = try request(state, "enroll", ["window_token": candidate(state), "purpose": "Fixture"])
            XCTAssertEqual(result["code"] as? String, "consent_denied")
        }
        XCTAssertEqual(backend.consentCalls, 1)
        XCTAssertEqual(backend.pressed, 0)
    }
    func testReadOnlyCannotEnroll() async throws {
        let backend = FakeBackend(); let state = session(backend, readOnly: true)
        let result = try request(state, "enroll", ["window_token": candidate(state), "purpose": "Fixture"])
        XCTAssertEqual(result["code"] as? String, "read_only")
        XCTAssertEqual(backend.consentCalls, 0)
    }
    func testProtectedAndAdditionalBundleDenial() async throws {
        let backend = FakeBackend()
        let state = session(backend, deny: ["EXAMPLE.FIXTURE"])
        XCTAssertEqual(try request(state, "targets", ["pid": 123])["code"] as? String, "protected_app")
        for bundle in ["com.apple.Terminal", "com.apple.SecurityAgent", "com.apple.systempreferences", "com.1password.1password", "com.google.Chrome"] {
            let b = FakeBackend()
            b.identity = ScopedAXIdentity(pid: 123, birth: "1", bundleID: bundle, appName: "Protected", executablePath: "/p", executableSHA256: "a", fileIdentity: "a")
            XCTAssertEqual(try request(session(b), "targets", ["pid": 123])["code"] as? String, "protected_app")
            XCTAssertEqual(b.consentCalls, 0)
        }
    }
    func testConsentRevalidatesIdentityBeforeGrant() async throws {
        let backend = FakeBackend(); backend.failValidationAt = 2; let state = session(backend)
        let result = try request(state, "enroll", ["window_token": candidate(state), "purpose": "Fixture"])
        XCTAssertEqual(result["code"] as? String, "identity_changed")
        XCTAssertNil(result["target_handle"])
        XCTAssertEqual(backend.consentCalls, 1)
    }
    func testCandidateExpiresAtMonotonicDeadline() async throws {
        let backend = FakeBackend(); let state = session(backend); let token = try candidate(state)
        backend.now += 60
        XCTAssertEqual(try request(state, "enroll", ["window_token": token, "purpose": "Fixture"])["code"] as? String, "candidate_expired")
        XCTAssertEqual(backend.consentCalls, 0)
    }
    func testGrantExpiresAtMonotonicDeadline() async throws {
        let backend = FakeBackend(); let state = session(backend); let handle = try enroll(state)
        let args = try pressArguments(state, handle: handle); backend.now += 300
        XCTAssertEqual(try request(state, "press", args)["code"] as? String, "target_expired")
        XCTAssertEqual(backend.pressed, 0)
        XCTAssertEqual(backend.released, 1)
    }
    func testEightPressLimitAndNoReplay() async throws {
        let backend = FakeBackend(); let state = session(backend); let handle = try enroll(state)
        for _ in 0..<8 {
            let args = try pressArguments(state, handle: handle)
            XCTAssertEqual(try request(state, "press", args)["code"] as? String, "axpress_dispatched")
            XCTAssertEqual(try request(state, "press", args)["code"] as? String, "action_replayed")
        }
        let args = try pressArguments(state, handle: handle)
        XCTAssertEqual(try request(state, "press", args)["code"] as? String, "quota_exhausted")
        XCTAssertEqual(backend.pressed, 8)
    }
    func testNewSnapshotInvalidatesOldElementTokens() async throws {
        let backend = FakeBackend(); let state = session(backend); let handle = try enroll(state)
        let old = try pressArguments(state, handle: handle)
        _ = try pressArguments(state, handle: handle)
        XCTAssertEqual(try request(state, "press", old)["code"] as? String, "stale_element")
        XCTAssertEqual(backend.pressed, 0)
    }
    func testUnknownDispatchRevokesAndStopsConnection() async throws {
        let backend = FakeBackend(); backend.dispatch = .unknown; let state = session(backend)
        let args = try pressArguments(state, handle: enroll(state))
        let result = try request(state, "press", args)
        XCTAssertEqual(result["disposition"] as? String, "unknown")
        XCTAssertEqual(result["remaining_presses"] as? Int, 7)
        XCTAssertEqual(try request(state, "targets", ["pid": 123])["code"] as? String, "session_unknown")
        XCTAssertEqual(try request(state, "press", args)["code"] as? String, "session_unknown")
        XCTAssertEqual(backend.pressed, 1)
        XCTAssertEqual(backend.released, 1)
    }
    func testFreshElementRevalidationPreventsDispatch() async throws {
        let backend = FakeBackend(); let state = session(backend); let handle = try enroll(state)
        let args = try pressArguments(state, handle: handle); backend.pressValidationFails = true
        XCTAssertEqual(try request(state, "press", args)["code"] as? String, "element_changed")
        XCTAssertEqual(backend.pressed, 0)
    }
    func testSessionTokensCannotCrossConnectionsAndReleaseRevokes() async throws {
        let backend = FakeBackend(); let state = session(backend); let handle = try enroll(state)
        XCTAssertEqual(try request(session(FakeBackend()), "snapshot", ["target_handle": handle])["code"] as? String, "unknown_target")
        XCTAssertEqual(try request(state, "release", ["target_handle": handle])["released"] as? Bool, true)
        XCTAssertEqual(try request(state, "snapshot", ["target_handle": handle])["code"] as? String, "unknown_target")
    }
    func testClosedSchemaBoundsAndRequestReplay() async throws {
        let backend = FakeBackend(); let state = session(backend)
        XCTAssertEqual(try request(state, "targets", ["pid": true])["code"] as? String, "invalid_pid")
        XCTAssertEqual(try request(state, "targets", ["pid": 123, "auto_approve": true])["code"] as? String, "invalid_arguments")
        XCTAssertEqual(state.handle(Data(repeating: 65, count: 65_537))["code"] as? String, "invalid_request")
        let id = UUID().uuidString.lowercased()
        _ = try request(state, "targets", ["pid": 123], id: id)
        XCTAssertEqual(try request(state, "targets", ["pid": 123], id: id)["code"] as? String, "request_replayed")
    }
    func testSnapshotBoundIsEnforcedEvenAgainstBackend() async throws {
        let backend = FakeBackend(); backend.elementCount = 300; let state = session(backend)
        let result = try request(state, "snapshot", ["target_handle": enroll(state)])
        XCTAssertEqual((result["elements"] as? [[String: Any]])?.count, 256)
        XCTAssertEqual(result["truncated"] as? Bool, true)
    }
    func testMetadataControlCharactersAreRemoved() async {
        XCTAssertEqual(ScopedAXPolicy.text("hi\u{001B}\n\u{202E}bye"), "hibye")
        XCTAssertEqual(ScopedAXPolicy.text(String(repeating: "a", count: 1_000)).count, 512)
    }
}
