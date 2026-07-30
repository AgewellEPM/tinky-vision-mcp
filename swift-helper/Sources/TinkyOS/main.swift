// tinky-os — macOS primitives CLI used by the MCP bridge.
//
// Why a CLI instead of an in-process Swift library?
//   - Node MCP SDK is the most mature host runtime
//   - Spawning a binary per call is fine (sub-50ms overhead) for
//     human-paced agent actions
//   - CLI is independently testable from a shell
//
// Subcommands:
//   tinky-os screenshot [--app <bundleID>] [--out <path>]
//                       capture screen or window; default = whole screen
//   tinky-os click  --x <int> --y <int> [--double]
//                       synthetic mouse click at screen coords
//   tinky-os type   --text "<string>"
//                       type text at currently-focused field
//   tinky-os key    --key <name> [--cmd] [--shift] [--opt] [--ctrl]
//                       press a single key (Return, Tab, Escape, F1-F12,
//                       or a single character) with optional modifiers
//   tinky-os apps
//                       list running .app processes with bundle IDs
//   tinky-os find-window --query "<substring>"
//                       list visible windows whose title or app contains
//                       the query
//   tinky-os ax-check
//                       0 if Accessibility granted, 1 if not
//   tinky-os ax-tree [--all] [--app <bundleID>] [--pid <int>] [--max <int>]
//                       snapshot visible app accessibility elements
//
//   --- controller model (act on a window regardless of z-order) ---
//   tinky-os control-click --window <id> --x <int> --y <int> [--double]
//                       click delivered to the window's owning process via
//                       postToPid — the target need NOT be frontmost, so a
//                       mirror hosted in another app (e.g. Chrome) can drive
//                       windows sitting behind it without raising them.
//   tinky-os move-window --window <id> --x <int> --y <int>
//                       reposition a window's top-left via AX (real move;
//                       this is "drag it around in the mirror").
//   tinky-os raise-window --window <id> [--activate]
//                       AX-raise a window (optionally activate its app) —
//                       targeted, so it does not shove the mirror host back.
//
// Output format: JSON to stdout on success, JSON to stderr on error.
// All stdout lines are valid JSON so the Node host can JSON.parse them
// directly.
//
// LABEL: PROTOTYPE — does the job for the MCP bridge pilot, no
// tests yet, no exit-code matrix verified.

import AppKit
import ApplicationServices
import CoreGraphics
import Vision
import ImageIO

// MARK: - JSON helpers

func jsonOut(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
       let s = String(data: data, encoding: .utf8) {
        print(s)
    }
}

func jsonErr(_ msg: String, code: Int32 = 1) -> Never {
    let payload = ["ok": false, "error": msg] as [String: Any]
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
       let s = String(data: data, encoding: .utf8) {
        FileHandle.standardError.write(Data((s + "\n").utf8))
    }
    exit(code)
}

// MARK: - Arg parsing (tiny — no Argument Parser dep)

struct Args {
    let cmd: String
    let opts: [String: String]
    let flags: Set<String>

    static func parse(_ argv: [String]) -> Args {
        guard argv.count >= 2 else {
            return Args(cmd: "help", opts: [:], flags: [])
        }
        let cmd = argv[1]
        var opts: [String: String] = [:]
        var flags: Set<String> = []
        var i = 2
        while i < argv.count {
            let a = argv[i]
            if a.hasPrefix("--") {
                let key = String(a.dropFirst(2))
                if i + 1 < argv.count, !argv[i + 1].hasPrefix("--") {
                    opts[key] = argv[i + 1]
                    i += 2
                } else {
                    flags.insert(key)
                    i += 1
                }
            } else { i += 1 }
        }
        return Args(cmd: cmd, opts: opts, flags: flags)
    }
}

// MARK: - Accessibility gate

func hasAccessibility() -> Bool {
    AXIsProcessTrusted()
}

func requireAccessibility() {
    if !hasAccessibility() {
        jsonErr(
            "Accessibility permission missing. Run `tinky-os ax-check` for detail, or add this binary in System Settings → Privacy & Security → Accessibility.",
            code: 3
        )
    }
}

// MARK: - Screenshot

func cmdScreenshot(_ args: Args) {
    // Use the system `/usr/sbin/screencapture` for reliability — it
    // handles multi-monitor, Retina scaling, and HDR correctly without
    // re-implementing CGImage capture ceremony.
    let outPath: String = args.opts["out"] ?? defaultScreenshotPath()
    var cmdArgs = ["-x"]                  // -x = no shutter sound
    if let bundleID = args.opts["app"] {
        // Capture a specific app's frontmost window. screencapture
        // takes -l <window-id>; we look up the window via CGWindowList.
        guard let winID = frontWindowID(forBundleID: bundleID) else {
            jsonErr("No visible window for bundle \(bundleID)")
        }
        cmdArgs.append("-l")
        cmdArgs.append("\(winID)")
        cmdArgs.append("-o")              // no window shadow
    }
    cmdArgs.append(outPath)
    let task = Process()
    task.launchPath = "/usr/sbin/screencapture"
    task.arguments = cmdArgs
    do {
        try task.run()
        task.waitUntilExit()
        if task.terminationStatus != 0 {
            jsonErr("screencapture exited \(task.terminationStatus)")
        }
        jsonOut([
            "ok": true,
            "path": outPath,
            "bytes": (try? FileManager.default.attributesOfItem(atPath: outPath)[.size] as? Int) ?? 0,
        ])
    } catch {
        jsonErr("screencapture failed: \(error.localizedDescription)")
    }
}

func defaultScreenshotPath() -> String {
    let dir = NSString(string: "~/Library/Caches/tinky-vision-mcp").expandingTildeInPath
    try? FileManager.default.createDirectory(
        atPath: dir, withIntermediateDirectories: true
    )
    let ts = Int(Date().timeIntervalSince1970 * 1000)
    return "\(dir)/shot-\(ts).png"
}

/// Look up the window id of the frontmost window for an app, by bundle
/// id. Returns nil if the app isn't running or has no on-screen windows.
func frontWindowID(forBundleID bundleID: String) -> CGWindowID? {
    guard let app = NSRunningApplication.runningApplications(
        withBundleIdentifier: bundleID
    ).first else { return nil }
    let pid = app.processIdentifier
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let arr = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
        return nil
    }
    for w in arr {
        if let wpid = w[kCGWindowOwnerPID as String] as? Int32, wpid == pid,
           let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
           let id = w[kCGWindowNumber as String] as? CGWindowID {
            return id
        }
    }
    return nil
}

// MARK: - Click

func cmdClick(_ args: Args) {
    requireAccessibility()
    guard let xs = args.opts["x"], let ys = args.opts["y"],
          let x = Int(xs), let y = Int(ys) else {
        jsonErr("--x and --y required")
    }
    let pt = CGPoint(x: x, y: y)
    let isDouble = args.flags.contains("double")
    postClick(at: pt, double: isDouble)
    jsonOut(["ok": true, "x": x, "y": y, "double": isDouble])
}

func postClick(at pt: CGPoint, double: Bool) {
    let src = CGEventSource(stateID: .combinedSessionState)
    let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown,
                       mouseCursorPosition: pt, mouseButton: .left)
    let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp,
                     mouseCursorPosition: pt, mouseButton: .left)
    if double {
        down?.setIntegerValueField(.mouseEventClickState, value: 2)
        up?.setIntegerValueField(.mouseEventClickState, value: 2)
    }
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
}

// MARK: - Controller model (targeted, z-order-independent)
//
// `click` above posts a physical HID tap that the window server routes to
// whatever window is frontmost — fine when the target is on top, useless
// when it's behind a mirror host (Chrome). These commands instead act on a
// SPECIFIC window identified by CGWindowID:
//   - clicks are delivered straight to the owning process (postToPid), so
//     z-order is irrelevant and the mirror host keeps its focus;
//   - moves/raises go through the Accessibility API on the exact window.
// CGWindow bounds, AX position, and CGEvent cursor position all use the
// same top-left global coordinate space, so no conversion is needed.

func rectFromBounds(_ bd: [String: Any]) -> CGRect {
    func d(_ k: String) -> CGFloat { CGFloat((bd[k] as? NSNumber)?.doubleValue ?? 0) }
    return CGRect(x: d("X"), y: d("Y"), width: d("Width"), height: d("Height"))
}

/// (pid, bounds) for an on-screen CGWindowID, or nil if it isn't visible.
func windowInfo(forID wid: CGWindowID) -> (pid: pid_t, bounds: CGRect)? {
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let arr = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
        return nil
    }
    for w in arr {
        guard let id = w[kCGWindowNumber as String] as? CGWindowID, id == wid else { continue }
        let pid = pid_t((w[kCGWindowOwnerPID as String] as? Int) ?? 0)
        let bounds = rectFromBounds((w[kCGWindowBounds as String] as? [String: Any]) ?? [:])
        return (pid, bounds)
    }
    return nil
}

/// Resolve a CGWindowID to its AX window element by matching the owning
/// app's AX windows against the CGWindow bounds. Returns the closest match
/// plus its positional drift (px) so callers can reject a loose match.
func axWindow(pid: pid_t, bounds: CGRect) -> (element: AXUIElement, drift: CGFloat)? {
    let appEl = AXUIElementCreateApplication(pid)
    let windows = axElements(appEl, kAXWindowsAttribute as CFString)
    var best: AXUIElement?
    var bestDrift = CGFloat.greatestFiniteMagnitude
    for win in windows {
        guard let pos = axPoint(win), let size = axSize(win) else { continue }
        let drift = abs(pos.x - bounds.minX) + abs(pos.y - bounds.minY)
                  + abs(size.width - bounds.width) + abs(size.height - bounds.height)
        if drift < bestDrift { bestDrift = drift; best = win }
    }
    guard let element = best else { return nil }
    return (element, bestDrift)
}

/// Resolve a CGWindowID to its owning app identity + bounds. The MCP host
/// uses this to point its sensitive-app deny-list at the ACTUAL target of a
/// targeted click (not the frontmost app, which under the controller model
/// is the mirror host, not the thing being driven).
func cmdWindowInfo(_ args: Args) {
    guard let ws = args.opts["window"], let wid = CGWindowID(ws) else {
        jsonErr("--window <CGWindowID> required")
    }
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    var found: [String: Any]?
    if let arr = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] {
        for w in arr {
            guard let id = w[kCGWindowNumber as String] as? CGWindowID, id == wid else { continue }
            let pid = pid_t((w[kCGWindowOwnerPID as String] as? Int) ?? 0)
            found = [
                "ok": true,
                "window": Int(wid),
                "pid": Int(pid),
                "bundleID": NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? "",
                "owner": (w[kCGWindowOwnerName as String] as? String) ?? "",
                "title": (w[kCGWindowName as String] as? String) ?? "",
                "bounds": (w[kCGWindowBounds as String] as? [String: Any]) ?? [:],
            ]
            break
        }
    }
    if let found { jsonOut(found) }
    else { jsonOut(["ok": false, "error": "no on-screen window with id \(wid)", "window": Int(wid)]) }
}

func cmdControlClick(_ args: Args) {
    requireAccessibility()
    guard let ws = args.opts["window"], let wid = CGWindowID(ws) else {
        jsonErr("--window <CGWindowID> required")
    }
    guard let xs = args.opts["x"], let ys = args.opts["y"],
          let x = Double(xs), let y = Double(ys) else {
        jsonErr("--x and --y required (global screen coords)")
    }
    guard let info = windowInfo(forID: wid) else {
        jsonErr("no on-screen window with id \(wid)")
    }
    let pt = CGPoint(x: x, y: y)
    let isDouble = args.flags.contains("double")
    postClickToPid(info.pid, at: pt, double: isDouble)
    jsonOut([
        "ok": true, "mode": "targeted", "window": Int(wid), "pid": Int(info.pid),
        "x": x, "y": y, "double": isDouble,
    ])
}

func postClickToPid(_ pid: pid_t, at pt: CGPoint, double: Bool) {
    let src = CGEventSource(stateID: .combinedSessionState)
    // A move first so the target sees the cursor land before the press —
    // some apps gate hit-testing on a preceding mouseMoved.
    let move = CGEvent(mouseEventSource: src, mouseType: .mouseMoved,
                       mouseCursorPosition: pt, mouseButton: .left)
    let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown,
                       mouseCursorPosition: pt, mouseButton: .left)
    let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp,
                     mouseCursorPosition: pt, mouseButton: .left)
    if double {
        down?.setIntegerValueField(.mouseEventClickState, value: 2)
        up?.setIntegerValueField(.mouseEventClickState, value: 2)
    }
    move?.postToPid(pid)
    down?.postToPid(pid)
    up?.postToPid(pid)
}

func cmdMoveWindow(_ args: Args) {
    requireAccessibility()
    guard let ws = args.opts["window"], let wid = CGWindowID(ws) else {
        jsonErr("--window <CGWindowID> required")
    }
    guard let xs = args.opts["x"], let ys = args.opts["y"],
          let x = Double(xs), let y = Double(ys) else {
        jsonErr("--x and --y required (new top-left position)")
    }
    guard let info = windowInfo(forID: wid) else {
        jsonErr("no on-screen window with id \(wid)")
    }
    guard let match = axWindow(pid: info.pid, bounds: info.bounds), match.drift <= 40 else {
        jsonErr("could not resolve AX window for id \(wid)")
    }
    var pos = CGPoint(x: x, y: y)
    guard let axVal = AXValueCreate(.cgPoint, &pos) else {
        jsonErr("failed to build AX position value")
    }
    let err = AXUIElementSetAttributeValue(match.element, kAXPositionAttribute as CFString, axVal)
    if err != .success {
        jsonErr("AXSetPosition failed (\(err.rawValue))")
    }
    jsonOut(["ok": true, "mode": "moved", "window": Int(wid), "pid": Int(info.pid), "x": x, "y": y])
}

func cmdRaiseWindow(_ args: Args) {
    requireAccessibility()
    guard let ws = args.opts["window"], let wid = CGWindowID(ws) else {
        jsonErr("--window <CGWindowID> required")
    }
    guard let info = windowInfo(forID: wid) else {
        jsonErr("no on-screen window with id \(wid)")
    }
    guard let match = axWindow(pid: info.pid, bounds: info.bounds), match.drift <= 40 else {
        jsonErr("could not resolve AX window for id \(wid)")
    }
    let err = AXUIElementPerformAction(match.element, kAXRaiseAction as CFString)
    if args.flags.contains("activate") {
        NSRunningApplication(processIdentifier: info.pid)?.activate(options: [])
    }
    jsonOut([
        "ok": err == .success, "mode": "raised", "window": Int(wid), "pid": Int(info.pid),
        "activated": args.flags.contains("activate"),
    ])
}

// MARK: - Control inbox daemon
//
// The Kist console runs under launchd and therefore has NO Accessibility grant
// (AX is attributed to the responsible parent — launchd, not a grant-holding
// app), so any `control-click`/`move-window`/`raise-window` it spawns dies with
// "Accessibility permission missing". This daemon is the fix: it runs INSIDE the
// stable Developer-ID TinkyStream.app bundle as its own LaunchAgent, so it holds
// the AX grant, and executes control requests the console drops into an inbox
// directory. Exactly the same pattern TinkyStream already uses to hold the
// Screen Recording grant for capture — here for Accessibility to drive windows.
//
// Protocol (file-based, atomic, no daemon deps):
//   request : <inbox>/<id>.req.json  = {"op":"click|move|raise","windowID":N,
//                                       "x":X,"y":Y,"double":bool}
//   result  : <inbox>/<id>.res.json  = the executed result dict (ok/error/…)
// The daemon writes the result atomically (tmp+rename) then deletes the request.
// The console generates <id>, polls for <id>.res.json, and cleans it up.

/// Execute a single control op WITHOUT exiting the process (unlike the cmd*
/// wrappers, which jsonErr→exit). Returns a JSON-serialisable result dict.
/// Fail-closed on a missing AX grant so the console surfaces the real reason
/// instead of a silently-dropped synthetic click.
func executeControlOp(op: String, windowID wid: CGWindowID, x: Double?, y: Double?, double: Bool) -> [String: Any] {
    // Validate the op before anything else so a bad op is reported the same way
    // regardless of grant state or whether the window is on screen.
    guard ["click", "move", "raise"].contains(op) else {
        return ["ok": false, "error": "unsupported control op: \(op)", "window": Int(wid)]
    }
    if !hasAccessibility() {
        return ["ok": false, "error": "Accessibility permission missing",
                "guard": "ax-grant-missing", "window": Int(wid)]
    }
    guard let info = windowInfo(forID: wid) else {
        return ["ok": false, "error": "no on-screen window with id \(wid)", "window": Int(wid)]
    }
    switch op {
    case "click":
        guard let x, let y else {
            return ["ok": false, "error": "click requires x and y", "window": Int(wid)]
        }
        postClickToPid(info.pid, at: CGPoint(x: x, y: y), double: double)
        return ["ok": true, "mode": "targeted", "op": "click", "window": Int(wid),
                "pid": Int(info.pid), "x": x, "y": y, "double": double]
    case "move":
        guard let x, let y else {
            return ["ok": false, "error": "move requires x and y", "window": Int(wid)]
        }
        guard let match = axWindow(pid: info.pid, bounds: info.bounds), match.drift <= 40 else {
            return ["ok": false, "error": "could not resolve AX window for id \(wid)", "window": Int(wid)]
        }
        var pos = CGPoint(x: x, y: y)
        guard let axVal = AXValueCreate(.cgPoint, &pos) else {
            return ["ok": false, "error": "failed to build AX position value", "window": Int(wid)]
        }
        let err = AXUIElementSetAttributeValue(match.element, kAXPositionAttribute as CFString, axVal)
        if err != .success {
            return ["ok": false, "error": "AXSetPosition failed (\(err.rawValue))", "window": Int(wid)]
        }
        return ["ok": true, "mode": "moved", "op": "move", "window": Int(wid),
                "pid": Int(info.pid), "x": x, "y": y]
    case "raise":
        guard let match = axWindow(pid: info.pid, bounds: info.bounds), match.drift <= 40 else {
            return ["ok": false, "error": "could not resolve AX window for id \(wid)", "window": Int(wid)]
        }
        let err = AXUIElementPerformAction(match.element, kAXRaiseAction as CFString)
        return ["ok": err == .success, "mode": "raised", "op": "raise",
                "window": Int(wid), "pid": Int(info.pid)]
    default:
        return ["ok": false, "error": "unsupported control op: \(op)", "window": Int(wid)]
    }
}

/// Parse a request dict → executeControlOp. Kept separate so it is unit-testable
/// without touching the filesystem.
func handleControlRequest(_ req: [String: Any]) -> [String: Any] {
    let op = ((req["op"] as? String) ?? "click").lowercased()
    // windowID may arrive as Int or String depending on the JSON encoder.
    let wid: CGWindowID?
    if let n = req["windowID"] as? Int { wid = CGWindowID(n) }
    else if let s = req["windowID"] as? String, let n = UInt32(s) { wid = CGWindowID(n) }
    else if let d = req["windowID"] as? Double { wid = CGWindowID(d) }
    else { wid = nil }
    guard let wid, wid > 0 else {
        return ["ok": false, "error": "valid windowID is required"]
    }
    func num(_ k: String) -> Double? {
        if let d = req[k] as? Double { return d }
        if let n = req[k] as? Int { return Double(n) }
        if let s = req[k] as? String, let d = Double(s) { return d }
        return nil
    }
    let double = (req["double"] as? Bool) ?? false
    return executeControlOp(op: op, windowID: wid, x: num("x"), y: num("y"), double: double)
}

func cmdControlInbox(_ args: Args) {
    guard let dir = args.opts["dir"] else {
        jsonErr("--dir <inbox> required")
    }
    let fm = FileManager.default
    try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let pollSeconds = Double(args.opts["poll"] ?? "") ?? 0.08
    // Startup line → launchd stdout log; confirms the grant-holder is live.
    jsonOut(["ok": true, "event": "control-inbox-started", "dir": dir,
             "accessibility": hasAccessibility()])
    fflush(stdout)  // non-TTY under launchd is block-buffered; flush so the log shows liveness
    while true {
        let names = (try? fm.contentsOfDirectory(atPath: dir)) ?? []
        // Oldest-first by name; ids are time-sortable so this preserves order.
        for name in names.filter({ $0.hasSuffix(".req.json") }).sorted() {
            let reqPath = (dir as NSString).appendingPathComponent(name)
            let id = String(name.dropLast(".req.json".count))
            var result: [String: Any]
            if let data = fm.contents(atPath: reqPath),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                result = handleControlRequest(obj)
            } else {
                result = ["ok": false, "error": "unreadable or malformed request"]
            }
            result["id"] = id
            writeResultAtomically(dir: dir, id: id, result: result)
            try? fm.removeItem(atPath: reqPath)
        }
        Thread.sleep(forTimeInterval: pollSeconds)
    }
}

func writeResultAtomically(dir: String, id: String, result: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) else { return }
    let finalPath = (dir as NSString).appendingPathComponent("\(id).res.json")
    let tmpPath = (dir as NSString).appendingPathComponent(".\(id).res.json.tmp")
    do {
        try data.write(to: URL(fileURLWithPath: tmpPath), options: .atomic)
        // rename is atomic within a dir → a reader never sees a half-written result.
        try? FileManager.default.removeItem(atPath: finalPath)
        try FileManager.default.moveItem(atPath: tmpPath, toPath: finalPath)
    } catch {
        try? FileManager.default.removeItem(atPath: tmpPath)
    }
}

// MARK: - Type text

func cmdType(_ args: Args) {
    requireAccessibility()
    guard let text = args.opts["text"] else { jsonErr("--text required") }
    typeString(text)
    jsonOut(["ok": true, "typed": text.count])
}

func typeString(_ s: String) {
    let src = CGEventSource(stateID: .combinedSessionState)
    // Posting via Unicode keyboard events handles arbitrary text
    // including emoji + non-ASCII without needing key-code maps.
    for scalar in s.unicodeScalars {
        var ch = UniChar(scalar.value & 0xFFFF)
        if let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true) {
            down.keyboardSetUnicodeString(stringLength: 1, unicodeString: &ch)
            down.post(tap: .cghidEventTap)
        }
        if let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) {
            up.keyboardSetUnicodeString(stringLength: 1, unicodeString: &ch)
            up.post(tap: .cghidEventTap)
        }
    }
}

// MARK: - Key press

let KEY_CODES: [String: CGKeyCode] = [
    "return": 36, "enter": 76, "tab": 48, "space": 49, "escape": 53,
    "delete": 51, "backspace": 51, "forwarddelete": 117,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99,  "f4": 118, "f5": 96,  "f6": 97,
    "f7": 98,  "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

func cmdKey(_ args: Args) {
    requireAccessibility()
    guard let keyName = args.opts["key"]?.lowercased() else { jsonErr("--key required") }
    let code: CGKeyCode
    if let c = KEY_CODES[keyName] {
        code = c
    } else if keyName.count == 1 {
        // Single ASCII char — type via Unicode (modifiers may not stick
        // perfectly for Cmd+single-letter shortcuts, but works for the
        // most common Cmd+S / Cmd+W cases via the modifier flags path
        // below).
        code = virtualCodeFor(char: keyName)
    } else {
        jsonErr("Unknown key '\(keyName)'. Known: \(KEY_CODES.keys.sorted().joined(separator: ", "))")
    }
    var flags: CGEventFlags = []
    if args.flags.contains("cmd")   { flags.insert(.maskCommand) }
    if args.flags.contains("shift") { flags.insert(.maskShift) }
    if args.flags.contains("opt")   { flags.insert(.maskAlternate) }
    if args.flags.contains("ctrl")  { flags.insert(.maskControl) }
    postKey(code: code, flags: flags)
    jsonOut([
        "ok": true,
        "key": keyName,
        "code": Int(code),
        "modifiers": modifierList(flags),
    ])
}

func modifierList(_ flags: CGEventFlags) -> [String] {
    var out: [String] = []
    if flags.contains(.maskCommand)   { out.append("cmd") }
    if flags.contains(.maskShift)     { out.append("shift") }
    if flags.contains(.maskAlternate) { out.append("opt") }
    if flags.contains(.maskControl)   { out.append("ctrl") }
    return out
}

func postKey(code: CGKeyCode, flags: CGEventFlags) {
    let src = CGEventSource(stateID: .combinedSessionState)
    let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)
    down?.flags = flags
    down?.post(tap: .cghidEventTap)
    let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
    up?.flags = flags
    up?.post(tap: .cghidEventTap)
}

/// Very small ASCII → US keyboard virtual key map. Only used when the
/// user passes a single-letter --key. For full text input, use `type`.
func virtualCodeFor(char: String) -> CGKeyCode {
    let map: [String: CGKeyCode] = [
        "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4,
        "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31,
        "p": 35, "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9,
        "w": 13, "x": 7, "y": 16, "z": 6,
        "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22,
        "7": 26, "8": 28, "9": 25,
    ]
    return map[char.lowercased()] ?? 49      // 49 = space fallback
}

// MARK: - List apps

func cmdApps(_ args: Args) {
    let apps = NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular }
        .compactMap { app -> [String: Any]? in
            guard let name = app.localizedName, let bundle = app.bundleIdentifier else { return nil }
            return [
                "name": name,
                "bundleID": bundle,
                "pid": Int(app.processIdentifier),
                "active": app.isActive,
            ]
        }
        .sorted { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
    jsonOut(["ok": true, "apps": apps])
}

// MARK: - Find window

func cmdFindWindow(_ args: Args) {
    let q = (args.opts["query"] ?? "").lowercased()
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let arr = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
        jsonOut(["ok": true, "windows": []])
        return
    }
    var matches: [[String: Any]] = []
    for w in arr {
        let title = (w[kCGWindowName as String] as? String) ?? ""
        let owner = (w[kCGWindowOwnerName as String] as? String) ?? ""
        let layer = (w[kCGWindowLayer as String] as? Int) ?? -1
        if layer != 0 { continue }
        let hay = (title + " " + owner).lowercased()
        if !q.isEmpty && !hay.contains(q) { continue }
        var b: [String: Any] = [:]
        if let bd = w[kCGWindowBounds as String] as? [String: Any] {
            b = bd
        }
        matches.append([
            "windowID": (w[kCGWindowNumber as String] as? Int) ?? 0,
            "title": title,
            "owner": owner,
            "pid": (w[kCGWindowOwnerPID as String] as? Int) ?? 0,
            "bounds": b,
        ])
    }
    jsonOut(["ok": true, "windows": matches])
}

// MARK: - Focused window
//
// Returns the bundle ID + visible bounds of the frontmost regular app's
// key window. The MCP host uses this to enforce a deny-list (do not
// click/type when 1Password / Keychain / SecurityAgent / bank-tab is the
// active target). Read-only; no AX gate required for the basic case.

func cmdFocusedWindow(_ args: Args) {
    guard let app = NSWorkspace.shared.frontmostApplication else {
        jsonOut(["ok": true, "focused": NSNull()])
        return
    }
    let bundleID = app.bundleIdentifier ?? ""
    let name = app.localizedName ?? ""
    let pid = app.processIdentifier

    // Find that app's topmost on-screen window (layer 0 = standard).
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    var winInfo: [String: Any] = [:]
    if let arr = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] {
        for w in arr {
            if let wpid = w[kCGWindowOwnerPID as String] as? Int32, wpid == pid,
               let layer = w[kCGWindowLayer as String] as? Int, layer == 0 {
                winInfo = [
                    "windowID": (w[kCGWindowNumber as String] as? Int) ?? 0,
                    "title": (w[kCGWindowName as String] as? String) ?? "",
                    "bounds": (w[kCGWindowBounds as String] as? [String: Any]) ?? [:],
                ]
                break
            }
        }
    }
    jsonOut([
        "ok": true,
        "focused": [
            "bundleID": bundleID,
            "name": name,
            "pid": Int(pid),
            "window": winInfo,
        ],
    ])
}

// MARK: - Accessibility tree

func axValue(_ element: AXUIElement, _ attr: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(element, attr, &value)
    if err == .success { return value }
    return nil
}

func axString(_ element: AXUIElement, _ attr: CFString) -> String {
    guard let value = axValue(element, attr) else { return "" }
    if let text = value as? String { return text }
    if let number = value as? NSNumber { return number.stringValue }
    return ""
}

func axBool(_ element: AXUIElement, _ attr: CFString) -> Bool? {
    guard let value = axValue(element, attr) else { return nil }
    if let bool = value as? Bool { return bool }
    if let number = value as? NSNumber { return number.boolValue }
    return nil
}

func axElements(_ element: AXUIElement, _ attr: CFString) -> [AXUIElement] {
    guard let value = axValue(element, attr) else { return [] }
    if let elements = value as? [AXUIElement] { return elements }
    if let array = value as? [AnyObject] {
        return array.map { $0 as! AXUIElement }
    }
    return []
}

func axPoint(_ element: AXUIElement) -> CGPoint? {
    guard let value = axValue(element, kAXPositionAttribute as CFString),
          CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    let ax = value as! AXValue
    guard
          AXValueGetType(ax) == .cgPoint else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(ax, .cgPoint, &point) ? point : nil
}

func axSize(_ element: AXUIElement) -> CGSize? {
    guard let value = axValue(element, kAXSizeAttribute as CFString),
          CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    let ax = value as! AXValue
    guard
          AXValueGetType(ax) == .cgSize else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(ax, .cgSize, &size) ? size : nil
}

func axLabel(role: String, title: String, value: String, desc: String, identifier: String) -> String {
    let parts = [title, value, desc, identifier]
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
    if !parts.isEmpty { return parts.joined(separator: " ") }
    return role.replacingOccurrences(of: "AX", with: "")
}

func visibleWindowRows() -> [[String: Any]] {
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let arr = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }
    var rows: [[String: Any]] = []
    for w in arr {
        let layer = (w[kCGWindowLayer as String] as? Int) ?? -1
        if layer != 0 { continue }
        rows.append([
            "windowID": (w[kCGWindowNumber as String] as? Int) ?? 0,
            "title": (w[kCGWindowName as String] as? String) ?? "",
            "owner": (w[kCGWindowOwnerName as String] as? String) ?? "",
            "pid": (w[kCGWindowOwnerPID as String] as? Int) ?? 0,
            "bounds": (w[kCGWindowBounds as String] as? [String: Any]) ?? [:],
        ])
    }
    return rows
}

func screenSnapshotInfo() -> [String: Any] {
    guard let screen = NSScreen.main else {
        return ["scale": 1.0]
    }
    let frame = screen.frame
    let scale = screen.backingScaleFactor
    return [
        "scale": Double(scale),
        "points": [
            "x": Int(frame.origin.x),
            "y": Int(frame.origin.y),
            "w": Int(frame.size.width),
            "h": Int(frame.size.height),
        ],
        "pixels": [
            "x": Int(frame.origin.x * scale),
            "y": Int(frame.origin.y * scale),
            "w": Int(frame.size.width * scale),
            "h": Int(frame.size.height * scale),
        ],
    ]
}

func appendAXElement(
    _ element: AXUIElement,
    app: NSRunningApplication,
    depth: Int,
    path: String,
    maxDepth: Int,
    maxCount: Int,
    scale: CGFloat,
    out: inout [[String: Any]],
    visited: inout Set<CFHashCode>
) {
    if out.count >= maxCount || depth > maxDepth { return }
    let key = CFHash(element)
    if visited.contains(key) { return }
    visited.insert(key)

    let role = axString(element, kAXRoleAttribute as CFString)
    let subrole = axString(element, kAXSubroleAttribute as CFString)
    let title = axString(element, kAXTitleAttribute as CFString)
    let value = axString(element, kAXValueAttribute as CFString)
    let desc = axString(element, kAXDescriptionAttribute as CFString)
    let identifier = axString(element, kAXIdentifierAttribute as CFString)
    let label = axLabel(role: role, title: title, value: value, desc: desc, identifier: identifier)
    let point = axPoint(element)
    let size = axSize(element)

    if let point, let size, size.width > 1, size.height > 1, (!label.isEmpty || !role.isEmpty) {
        let px = Int(point.x * scale)
        let py = Int(point.y * scale)
        let pw = Int(size.width * scale)
        let ph = Int(size.height * scale)
        let id = String(format: "AX%03d", out.count + 1)
        out.append([
            "id": id,
            "source": "ax",
            "role": role,
            "kind": role.isEmpty ? "AXElement" : role,
            "subrole": subrole,
            "label": String(label.prefix(180)),
            "title": String(title.prefix(180)),
            "value": String(value.prefix(180)),
            "description": String(desc.prefix(180)),
            "identifier": String(identifier.prefix(120)),
            "app": app.localizedName ?? "",
            "bundleID": app.bundleIdentifier ?? "",
            "pid": Int(app.processIdentifier),
            "enabled": axBool(element, kAXEnabledAttribute as CFString) as Any,
            "focused": axBool(element, kAXFocusedAttribute as CFString) as Any,
            "depth": depth,
            "path": path,
            "pointBounds": [
                "x": Int(point.x), "y": Int(point.y),
                "w": Int(size.width), "h": Int(size.height),
                "cx": Int(point.x + size.width / 2),
                "cy": Int(point.y + size.height / 2),
            ],
            "pixelBounds": [
                "x": px, "y": py, "w": pw, "h": ph,
                "cx": px + pw / 2, "cy": py + ph / 2,
            ],
        ])
    }

    var children: [AXUIElement] = []
    children.append(contentsOf: axElements(element, kAXVisibleChildrenAttribute as CFString))
    children.append(contentsOf: axElements(element, kAXChildrenAttribute as CFString))
    children.append(contentsOf: axElements(element, kAXContentsAttribute as CFString))
    for (index, child) in children.enumerated() {
        if out.count >= maxCount { break }
        appendAXElement(
            child,
            app: app,
            depth: depth + 1,
            path: "\(path)/\(role.isEmpty ? "element" : role)[\(index)]",
            maxDepth: maxDepth,
            maxCount: maxCount,
            scale: scale,
            out: &out,
            visited: &visited
        )
    }
}

func cmdAXTree(_ args: Args) {
    requireAccessibility()
    let maxCount = Int(args.opts["max"] ?? "600") ?? 600
    let maxDepth = Int(args.opts["depth"] ?? "8") ?? 8
    let allVisible = args.flags.contains("all")
    let bundleID = args.opts["app"] ?? args.opts["bundle"]
    let pidFilter = args.opts["pid"].flatMap { Int32($0) }
    let screen = screenSnapshotInfo()
    let scale = CGFloat((screen["scale"] as? Double) ?? 1.0)
    let windows = visibleWindowRows()
    var apps: [NSRunningApplication] = []

    if let pidFilter {
        if let app = NSRunningApplication(processIdentifier: pid_t(pidFilter)) {
            apps = [app]
        }
    } else if let bundleID, !bundleID.isEmpty {
        apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
    } else if allVisible {
        let pids = Set(windows.compactMap { row -> pid_t? in
            guard let pid = row["pid"] as? Int else { return nil }
            return pid_t(pid)
        })
        apps = pids.compactMap { NSRunningApplication(processIdentifier: $0) }
    } else if let app = NSWorkspace.shared.frontmostApplication {
        apps = [app]
    }

    var elements: [[String: Any]] = []
    var visited = Set<CFHashCode>()
    for app in apps {
        if elements.count >= maxCount { break }
        let root = AXUIElementCreateApplication(app.processIdentifier)
        var roots = axElements(root, kAXWindowsAttribute as CFString)
        if roots.isEmpty { roots = [root] }
        for (index, item) in roots.enumerated() {
            appendAXElement(
                item,
                app: app,
                depth: 0,
                path: "\(app.bundleIdentifier ?? "app")/window[\(index)]",
                maxDepth: maxDepth,
                maxCount: maxCount,
                scale: scale,
                out: &elements,
                visited: &visited
            )
        }
    }

    elements.sort {
        let a = $0["pixelBounds"] as? [String: Any] ?? [:]
        let b = $1["pixelBounds"] as? [String: Any] ?? [:]
        let ay = a["y"] as? Int ?? 0
        let by = b["y"] as? Int ?? 0
        if ay != by { return ay < by }
        return (a["x"] as? Int ?? 0) < (b["x"] as? Int ?? 0)
    }

    jsonOut([
        "ok": true,
        "accessibility": true,
        "mode": pidFilter != nil ? "pid" : (bundleID != nil ? "app" : (allVisible ? "all-visible-apps" : "frontmost-app")),
        "appFilter": bundleID as Any,
        "pidFilter": pidFilter as Any,
        "screen": screen,
        "windows": windows,
        "elements": elements,
        "elementCount": elements.count,
    ])
}

// MARK: - OCR (find-text)
//
// Captures a screenshot of the whole main screen (or an existing image
// file when --in is provided), runs Vision's text recognizer, returns
// bounding boxes in BOTH image-pixel coords AND screen-point coords so
// the MCP server can feed them straight to `click_at`.
//
// Single-screen assumption is documented — multi-monitor falls back to
// image-pixel coords only (screen_x/y == null). Good enough for the
// pilot; explicit so the host can decide what to do.

func cmdFindText(_ args: Args) {
    // Acquire a CGImage to OCR. Two paths:
    //   --in <png>  → load from disk (testable + lets us OCR app-only shots)
    //   default     → capture full main screen now via screencapture
    let imagePath: String
    if let p = args.opts["in"] {
        imagePath = p
    } else {
        let outPath = defaultScreenshotPath()
        let task = Process()
        task.launchPath = "/usr/sbin/screencapture"
        task.arguments = ["-x", outPath]
        do {
            try task.run(); task.waitUntilExit()
            if task.terminationStatus != 0 { jsonErr("screencapture exited \(task.terminationStatus)") }
        } catch { jsonErr("screencapture failed: \(error.localizedDescription)") }
        imagePath = outPath
    }

    guard let url = URL(string: "file://\(imagePath)"),
          let src = CGImageSourceCreateWithURL(url as CFURL, nil),
          let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        jsonErr("Could not load image at \(imagePath)")
    }
    let imgW = CGFloat(cg.width)
    let imgH = CGFloat(cg.height)

    // Set up Vision request synchronously; recognitionLevel = accurate is
    // ~250ms per shot on M1, worth the latency for the agent loop. Add
    // a query-driven recognition language hint if available.
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    if #available(macOS 13.0, *) {
        request.recognitionLanguages = ["en-US"]
    }

    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do { try handler.perform([request]) }
    catch { jsonErr("Vision OCR failed: \(error.localizedDescription)") }

    let observations = (request.results ?? [])
    let queryRaw = args.opts["query"] ?? ""
    let query = queryRaw.lowercased()

    // For screen-coord conversion: assume main display, derive scale
    // from image px / NSScreen points. Multi-monitor → returns null.
    var screenScale: CGFloat? = nil
    if let screen = NSScreen.main {
        let pts = screen.frame.size
        // If image dims look like an integer multiple of the screen's
        // point size we can trust the conversion. Otherwise leave null
        // and let the host handle pixel coords.
        let scaleX = imgW / pts.width
        let scaleY = imgH / pts.height
        if abs(scaleX - scaleY) < 0.05 { screenScale = scaleX }
    }

    var matches: [[String: Any]] = []
    for obs in observations {
        guard let top = obs.topCandidates(1).first else { continue }
        let text = top.string
        if !query.isEmpty && !text.lowercased().contains(query) { continue }

        // Vision bbox: normalized 0-1, origin BOTTOM-LEFT.
        let bb = obs.boundingBox
        let pxX = bb.minX * imgW
        let pxY = (1.0 - bb.maxY) * imgH          // flip Y to top-origin
        let pxW = bb.width * imgW
        let pxH = bb.height * imgH
        let pxCx = pxX + pxW / 2
        let pxCy = pxY + pxH / 2

        var entry: [String: Any] = [
            "text": text,
            "confidence": Double(top.confidence),
            "image_px": [
                "x": Int(pxX), "y": Int(pxY),
                "w": Int(pxW), "h": Int(pxH),
                "cx": Int(pxCx), "cy": Int(pxCy),
            ],
        ]
        if let s = screenScale, s > 0 {
            entry["screen_pt"] = [
                "x": Int(pxX / s), "y": Int(pxY / s),
                "w": Int(pxW / s), "h": Int(pxH / s),
                "cx": Int(pxCx / s), "cy": Int(pxCy / s),
            ]
        } else {
            entry["screen_pt"] = NSNull()
        }
        matches.append(entry)
    }

    jsonOut([
        "ok": true,
        "image": [
            "path": imagePath,
            "width_px": Int(imgW),
            "height_px": Int(imgH),
            "screen_scale": screenScale.map { Double($0) } as Any,
        ],
        "query": queryRaw,
        "matches": matches,
        "match_count": matches.count,
    ])
}

// MARK: - AX check

func cmdAXCheck(_ args: Args) {
    let granted = hasAccessibility()
    jsonOut(["ok": true, "accessibility": granted])
    exit(granted ? 0 : 1)
}

// MARK: - Stream (continuous ScreenCaptureKit capture → atomic JPEG frames)
//
// `tinky-os stream --out DIR [--fps N] [--scale F] [--quality F] [--ring N]`
// writes DIR/latest.jpg atomically (tmp + rename) at up to N fps, plus an
// optional bounded ring of numbered frames (frame-0000.jpg … frame-(ring-1).jpg,
// slots reused cyclically — history is capped by construction, never pruned by
// a separate job). Runs until SIGTERM/SIGINT; heartbeats JSON to stdout every
// 5s so a supervisor can verify liveness. Requires Screen Recording permission
// on the responsible process (same TCC grant `screenshot` already relies on).

import ScreenCaptureKit
import CoreImage
import CoreMedia

final class StreamSink: NSObject, SCStreamOutput, SCStreamDelegate {
    private let dir: URL
    private let ring: Int
    private let quality: CGFloat
    // Output basename (e.g. "latest.jpg" for the full mirror, "seethrough-latest.jpg"
    // for the Chrome-excluded see-through mirror). Lets one process run two streams
    // to two distinct frame files without clobbering each other.
    private let latestName: String
    private let tmpName: String
    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private let colorSpace = CGColorSpaceCreateDeviceRGB()
    // Written on the sample queue, read from the heartbeat loop. Int reads of a
    // monotonically-increasing counter are tolerable here; a lock would be
    // overkill for a diagnostic heartbeat.
    private(set) var frames: Int = 0
    private(set) var writeFailures: Int = 0

    init(dir: URL, ring: Int, quality: CGFloat, latestName: String = "latest.jpg") {
        self.dir = dir
        self.ring = ring
        self.quality = quality
        self.latestName = latestName
        // Distinct tmp per output so the two streams' atomic writes never race.
        self.tmpName = ".\(latestName).tmp"
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .screen,
              sampleBuffer.isValid,
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        let qualityKey = CIImageRepresentationOption(
            rawValue: kCGImageDestinationLossyCompressionQuality as String)
        guard let jpeg = ciContext.jpegRepresentation(
            of: image, colorSpace: colorSpace, options: [qualityKey: quality]) else {
            writeFailures += 1
            return
        }
        let tmp = dir.appendingPathComponent(tmpName)
        let latest = dir.appendingPathComponent(latestName)
        do {
            try jpeg.write(to: tmp)
            _ = try FileManager.default.replaceItemAt(latest, withItemAt: tmp)
            if ring > 0 {
                try? jpeg.write(to: dir.appendingPathComponent(
                    String(format: "frame-%04d.jpg", frames % ring)))
            }
            frames += 1
        } catch {
            writeFailures += 1
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let payload = ["ok": false, "error": "stream stopped: \(error.localizedDescription)"] as [String: Any]
        if let data = try? JSONSerialization.data(withJSONObject: payload),
           let s = String(data: data, encoding: .utf8) {
            FileHandle.standardError.write(Data((s + "\n").utf8))
        }
        exit(4)
    }
}

// Build the capture filter for a display. With no exclusions this is the plain
// full-display filter (unchanged behavior). With `excludeBundleIDs` set, exclude
// every window belonging to those apps at the APPLICATION level — so newly opened
// windows of the same app stay excluded and ScreenCaptureKit composites the
// display AS IF those apps don't exist, revealing whatever is behind them. This is
// the see-through mirror: Chrome vanishes from the frame while staying fully real
// and interactive on the actual screen.
func makeFilter(display: SCDisplay, content: SCShareableContent,
                excludeBundleIDs: Set<String>) -> SCContentFilter {
    if excludeBundleIDs.isEmpty {
        return SCContentFilter(display: display, excludingWindows: [])
    }
    // Case-insensitive: Chrome's real bundle ID is "com.google.Chrome" (capital C),
    // so a case-sensitive match silently excludes nothing.
    let wanted = Set(excludeBundleIDs.map { $0.lowercased() })
    let apps = content.applications.filter { wanted.contains($0.bundleIdentifier.lowercased()) }
    if apps.isEmpty {
        // Target apps not running yet — nothing to exclude this cycle; a later
        // refresh picks them up the moment they launch.
        return SCContentFilter(display: display, excludingWindows: [])
    }
    return SCContentFilter(display: display, excludingApplications: apps, exceptingWindows: [])
}

// One retry-alive capture loop writing to `sink`. Optionally excludes apps
// (see-through). When excluding, the filter is refreshed on each heartbeat so
// target apps launching/quitting after start are still handled.
func runStream(sink: StreamSink, label: String, outDir: String,
               fps: Int, scale: Double, ring: Int,
               excludeBundleIDs: Set<String>,
               hold: @escaping (SCStream) -> Void) async {
    var attempt = 0
    while true {
        attempt += 1
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: false)
            guard let display = content.displays.first else {
                throw NSError(domain: "tinky.stream", code: 3, userInfo: [
                    NSLocalizedDescriptionKey: "no capturable display yet"])
            }
            let config = SCStreamConfiguration()
            config.width = max(64, Int(Double(display.width) * scale))
            config.height = max(64, Int(Double(display.height) * scale))
            config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.queueDepth = 5
            config.showsCursor = true
            let filter = makeFilter(display: display, content: content,
                                    excludeBundleIDs: excludeBundleIDs)
            let stream = SCStream(filter: filter, configuration: config, delegate: sink)
            try stream.addStreamOutput(
                sink, type: .screen,
                sampleHandlerQueue: DispatchQueue(label: "tinky.stream.sample.\(label)"))
            try await stream.startCapture()
            hold(stream) // lifetime anchor held by caller
            jsonOut(["ok": true, "streaming": true, "stream": label, "dir": outDir,
                     "fps": fps, "scale": scale, "ring": ring,
                     "excludes": Array(excludeBundleIDs).sorted(),
                     "width": config.width, "height": config.height,
                     "grantedAfterAttempts": attempt])
            fflush(stdout)
            while true {
                try await Task.sleep(nanoseconds: 5_000_000_000)
                jsonOut(["ok": true, "heartbeat": true, "stream": label,
                         "frames": sink.frames, "writeFailures": sink.writeFailures])
                fflush(stdout)
                // Refresh the exclusion filter so Chrome windows opened after the
                // stream started are still excluded (and quit ones stop being).
                if !excludeBundleIDs.isEmpty,
                   let fresh = try? await SCShareableContent.excludingDesktopWindows(
                       false, onScreenWindowsOnly: false),
                   let disp = fresh.displays.first {
                    let refreshed = makeFilter(display: disp, content: fresh,
                                               excludeBundleIDs: excludeBundleIDs)
                    try? await stream.updateContentFilter(refreshed)
                }
            }
        } catch {
            // Stay alive through the permission prompt; do NOT exit.
            jsonOut(["ok": false, "awaitingPermission": true, "stream": label,
                     "attempt": attempt,
                     "hint": "Grant Screen Recording to this app, then it streams automatically",
                     "error": error.localizedDescription])
            fflush(stdout)
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
    }
}

func cmdStream(_ args: Args) {
    guard let outDir = args.opts["out"] else {
        jsonErr("stream requires --out <dir>")
    }
    let fps = max(1, min(60, Int(args.opts["fps"] ?? "15") ?? 15))
    let scale = min(1.0, max(0.1, Double(args.opts["scale"] ?? "0.5") ?? 0.5))
    let quality = min(1.0, max(0.1, Double(args.opts["quality"] ?? "0.6") ?? 0.6))
    let ring = max(0, Int(args.opts["ring"] ?? "0") ?? 0)
    // See-through: apps to make invisible in a SECOND frame (seethrough-latest.jpg).
    // Comma-separated bundle IDs; empty disables the second stream. The primary
    // latest.jpg is ALWAYS the full frame so Chrome vision/task paths keep working.
    let excludeBundleIDs = Set(
        (args.opts["exclude-app"] ?? "")
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty })
    // A slower see-through fps keeps two concurrent captures light on the GPU.
    let seethroughFps = max(1, min(fps, Int(args.opts["seethrough-fps"] ?? "8") ?? 8))
    let dir = URL(fileURLWithPath: outDir, isDirectory: true)
    do {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    } catch {
        jsonErr("cannot create --out dir \(outDir): \(error.localizedDescription)")
    }

    // Retain both streams for process lifetime; released only at exit.
    var retained: [SCStream] = []
    let retainLock = NSLock()
    let hold: (SCStream) -> Void = { s in
        retainLock.lock(); retained.append(s); retainLock.unlock()
    }

    let primary = StreamSink(dir: dir, ring: ring, quality: CGFloat(quality))
    Task {
        await runStream(sink: primary, label: "full", outDir: outDir, fps: fps,
                        scale: scale, ring: ring, excludeBundleIDs: [], hold: hold)
    }
    if !excludeBundleIDs.isEmpty {
        let seethrough = StreamSink(dir: dir, ring: 0, quality: CGFloat(quality),
                                    latestName: "seethrough-latest.jpg")
        Task {
            await runStream(sink: seethrough, label: "seethrough", outDir: outDir,
                            fps: seethroughFps, scale: scale, ring: 0,
                            excludeBundleIDs: excludeBundleIDs, hold: hold)
        }
    }
    dispatchMain()
}

// MARK: - Approvals refresh (Sequoia monthly nag suppressor)

/// Push every Screen-Recording approval's next-nag date far into the future so macOS Sequoia's
/// periodic re-authorization prompt never fires. The nag is keyed on a TIMESTAMP
/// (`kScreenCapturePrivacyHintDate`, = lastAlerted + 30d) in the replayd group container — NOT on
/// code signature — so pushing the date forward suppresses it. macOS rewrites the date on each
/// capture, so a LaunchAgent must run this on a recurring schedule.
///
/// Runs INSIDE the TinkyStream.app bundle so it inherits the app's Full Disk Access grant (the
/// group container is TCC-protected App-Data; a bare launchd process without FDA gets EPERM). This
/// is why the refresh lives here and not in a standalone python launchd job.
func cmdApprovalsRefresh(_ args: Args) {
    let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
    let path = "\(home)/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist"
    // Optional substring filters: `approvals-refresh --only tinky` → only matching exec paths.
    let onlyFilter = args.opts["only"]
    // Far-future date: 2099-01-01 UTC.
    var comps = DateComponents()
    comps.year = 2099; comps.month = 1; comps.day = 1
    comps.timeZone = TimeZone(identifier: "UTC")
    guard let farFuture = Calendar(identifier: .gregorian).date(from: comps) else {
        jsonErr("could not build far-future date")
    }

    guard FileManager.default.fileExists(atPath: path) else {
        jsonOut(["ok": true, "refreshed": 0, "note": "approvals plist absent — nothing to refresh"])
        exit(0)
    }
    guard let data = FileManager.default.contents(atPath: path) else {
        jsonErr("cannot read approvals plist (Full Disk Access needed for this app?): \(path)", code: 5)
    }
    var format = PropertyListSerialization.PropertyListFormat.binary
    guard var root = (try? PropertyListSerialization.propertyList(
        from: data, options: [.mutableContainersAndLeaves], format: &format)) as? [String: Any] else {
        jsonErr("approvals plist is not a dictionary", code: 5)
    }

    var refreshed = 0
    for (execPath, value) in root {
        guard var entry = value as? [String: Any] else { continue }
        if let onlyFilter, !execPath.contains(onlyFilter) { continue }
        let cur = entry["kScreenCapturePrivacyHintDate"] as? Date
        if cur != farFuture {
            entry["kScreenCapturePrivacyHintDate"] = farFuture
            entry["kScreenCaptureApprovalLastAlerted"] = farFuture
            root[execPath] = entry
            refreshed += 1
        }
    }

    if refreshed > 0 {
        do {
            let out = try PropertyListSerialization.data(
                fromPropertyList: root, format: format, options: 0)
            try out.write(to: URL(fileURLWithPath: path), options: .atomic)
        } catch {
            jsonErr("cannot write approvals plist: \(error.localizedDescription)", code: 5)
        }
        // Force replayd to reload the on-disk state (user agent — no sudo needed).
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/killall")
        p.arguments = ["replayd"]
        try? p.run(); p.waitUntilExit()
    }
    jsonOut(["ok": true, "refreshed": refreshed, "hintDate": "2099-01-01"])
    exit(0)
}

// MARK: - Main

/// When LaunchServices/launchd starts the `.app` bundle, the executable is invoked with NO
/// subcommand (argv.count == 1) — which would otherwise fall through to `help` and exit
/// immediately. Detect the bundle context and synthesize a `stream` invocation instead, so the
/// signed app auto-streams (with retry-alive) the moment it launches. Stream parameters come from
/// the environment (set by the LaunchAgent), with sane defaults. The plain CLI is unaffected:
/// a bare `tinky-os` outside a bundle still prints help.
func bundleStreamArgsIfLaunchedAsApp() -> Args? {
    guard CommandLine.arguments.count < 2 else { return nil }
    // Running inside `TinkyStream.app/Contents/MacOS/…`? Bundle.main has an .app path then.
    let path = Bundle.main.bundlePath
    guard path.hasSuffix(".app") else { return nil }
    let env = ProcessInfo.processInfo.environment
    let defaultOut = (env["HOME"].map { "\($0)/.kist/stream" }) ?? "/tmp/tinky-stream"
    var opts: [String: String] = ["out": env["TINKY_STREAM_OUT"] ?? defaultOut]
    if let v = env["TINKY_STREAM_FPS"] { opts["fps"] = v }
    if let v = env["TINKY_STREAM_SCALE"] { opts["scale"] = v }
    if let v = env["TINKY_STREAM_QUALITY"] { opts["quality"] = v }
    if let v = env["TINKY_STREAM_RING"] { opts["ring"] = v }
    // See-through mirror on by default: exclude Chrome from a second frame
    // (seethrough-latest.jpg). Override with TINKY_STREAM_EXCLUDE_APPS (set to
    // "" to disable, or a comma-separated bundle-ID list to change targets).
    opts["exclude-app"] = env["TINKY_STREAM_EXCLUDE_APPS"] ?? "com.google.chrome"
    if let v = env["TINKY_STREAM_SEETHROUGH_FPS"] { opts["seethrough-fps"] = v }
    return Args(cmd: "stream", opts: opts, flags: [])
}

let args = bundleStreamArgsIfLaunchedAsApp() ?? Args.parse(CommandLine.arguments)
switch args.cmd {
case "screenshot":   cmdScreenshot(args)
case "click":        cmdClick(args)
case "window-info":  cmdWindowInfo(args)
case "control-click": cmdControlClick(args)
case "move-window":  cmdMoveWindow(args)
case "raise-window": cmdRaiseWindow(args)
case "control-inbox": cmdControlInbox(args)
case "type":         cmdType(args)
case "key":          cmdKey(args)
case "apps":           cmdApps(args)
case "find-window":    cmdFindWindow(args)
case "focused-window": cmdFocusedWindow(args)
case "find-text":      cmdFindText(args)
case "ax-tree":        cmdAXTree(args)
case "ax-check":       cmdAXCheck(args)
case "stream":         cmdStream(args)
case "approvals-refresh": cmdApprovalsRefresh(args)
case "help", "--help", "-h":
    print("""
    tinky-os — macOS primitives for the Tinky Vision MCP bridge.

    Commands:
      screenshot [--app <bundleID>] [--out <path>]
      click --x <int> --y <int> [--double]
      type --text "<string>"
      key --key <name> [--cmd] [--shift] [--opt] [--ctrl]
      apps
      find-window --query "<substring>"
      focused-window
      find-text [--query "<substring>"] [--in <png>]
      ax-tree [--all] [--app <bundleID>] [--pid <int>] [--max <int>] [--depth <int>]
      ax-check
      stream --out <dir> [--fps <1-60>] [--scale <0.1-1>] [--quality <0.1-1>] [--ring <n>]
             [--exclude-app <bundleID,…>] [--seethrough-fps <1-60>]
             # --exclude-app writes a second see-through frame (seethrough-latest.jpg)
             # with those apps excluded from the composite — invisible in the mirror,
             # untouched on the real screen. latest.jpg stays the full frame.
      window-info --window <CGWindowID>
      control-click --window <id> --x <int> --y <int> [--double]
      move-window --window <id> --x <int> --y <int>
      raise-window --window <id> [--activate]
      control-inbox --dir <inbox> [--poll <seconds>]
             # grant-holder daemon: executes control ops the launchd console
             # drops as <id>.req.json, writes <id>.res.json. Runs inside
             # TinkyStream.app so it holds the Accessibility grant.
    """)
default:
    jsonErr("Unknown command '\(args.cmd)'. Run `tinky-os help`.")
}
