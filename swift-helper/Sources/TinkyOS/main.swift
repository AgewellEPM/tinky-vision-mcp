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
// Output format: JSON to stdout on success, JSON to stderr on error.
// All stdout lines are valid JSON so the Node host can JSON.parse them
// directly.
//
// LABEL: PROTOTYPE — does the job for the MCP bridge pilot, no
// tests yet, no exit-code matrix verified.

import AppKit
import ScopedAX
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
// a separate job). When --archive-dir is set, the full stream is also sealed
// into timestamped five-minute MP4 segments before the live ring cycles onward.
// Runs until SIGTERM/SIGINT; heartbeats JSON to stdout every 5s so a supervisor
// can verify liveness. Requires Screen Recording permission on the responsible
// process (same TCC grant `screenshot` already relies on).

import ScreenCaptureKit
import CoreImage
import CoreMedia
import AVFoundation

// Persistent history is deliberately separate from the bounded JPEG recycler:
// the ring stays at 300 slots for low-latency inspection, while AVAssetWriter
// receives the same pixel buffers and closes one independently playable MP4 per
// time block. Existing archives are never rotated or deleted. If the configured
// free-space reserve is reached, only archival pauses; latest.jpg and the live
// ring continue normally.
final class StreamArchiveWriter {
    private let root: URL
    private let streamName: String
    private let fps: Int
    private let segmentSeconds: Int
    private let segmentFrames: Int
    private let minimumFreeBytes: Int64
    private let bitrateKbps: Int

    // Active writer state is touched only by StreamSink's serial sample queue.
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var partialURL: URL?
    private var finalURL: URL?
    private var manifestURL: URL?
    private var segmentStartedAt: Date?
    private var segmentFirstSourceFrame: Int = 0
    private var segmentLastSourceFrame: Int = 0
    private var framesInSegment: Int = 0
    private var sourceFramesSeen: Int = 0

    // Completion callbacks and heartbeat reads can happen off the sample queue.
    private let statsLock = NSLock()
    private var completedSegments: Int = 0
    private var failedSegments: Int = 0
    private var backpressureDrops: Int = 0
    private var lowSpaceSkippedFrames: Int = 0
    private var finishingSegments: Int = 0
    private var pausedForLowSpace: Bool = false
    private var lastCompletedPath: String?
    private var lastError: String?

    init(root: URL, streamName: String, fps: Int, segmentSeconds: Int,
         minimumFreeBytes: Int64, bitrateKbps: Int) {
        self.root = root
        self.streamName = streamName
        self.fps = fps
        self.segmentSeconds = segmentSeconds
        self.segmentFrames = max(1, fps * segmentSeconds)
        self.minimumFreeBytes = minimumFreeBytes
        self.bitrateKbps = bitrateKbps
    }

    private func makeDirectory(_ url: URL) throws {
        try FileManager.default.createDirectory(
            at: url, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        try? FileManager.default.setAttributes(
            [.posixPermissions: 0o700], ofItemAtPath: url.path)
    }

    private func availableCapacity() -> Int64? {
        guard let values = try? root.resourceValues(forKeys: [
            .volumeAvailableCapacityForImportantUsageKey,
            .volumeAvailableCapacityKey,
        ]) else { return nil }
        if let basic = values.volumeAvailableCapacity {
            return Int64(basic)
        }
        // Important-usage capacity may include purgeable bytes. Use it only as
        // a fallback so the configured reserve reflects genuinely free space.
        if let important = values.volumeAvailableCapacityForImportantUsage {
            return important
        }
        return nil
    }

    private func stamp(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd_HH-mm-ss"
        return formatter.string(from: date)
    }

    private func dayStamp(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    private func recordError(_ message: String, failedSegment: Bool = false) {
        statsLock.lock()
        lastError = message
        if failedSegment { failedSegments += 1 }
        statsLock.unlock()
    }

    private func beginSegment(width: Int, height: Int) -> Bool {
        do {
            try makeDirectory(root)
        } catch {
            recordError("cannot create archive folder: \(error.localizedDescription)",
                        failedSegment: true)
            return false
        }

        guard let freeBytes = availableCapacity() else {
            recordError("cannot determine free disk space; archival paused")
            return false
        }
        guard freeBytes >= minimumFreeBytes else {
            statsLock.lock()
            pausedForLowSpace = true
            lowSpaceSkippedFrames += 1
            lastError = "archive paused below free-space reserve"
            statsLock.unlock()
            return false
        }
        guard width.isMultiple(of: 2), height.isMultiple(of: 2) else {
            recordError("archive requires even video dimensions (got \(width)x\(height))",
                        failedSegment: true)
            return false
        }

        do {
            let started = Date()
            let nominalEnd = started.addingTimeInterval(TimeInterval(segmentSeconds))
            let day = root.appendingPathComponent(dayStamp(started), isDirectory: true)
            try makeDirectory(day)
            let token = String(UUID().uuidString.prefix(8)).lowercased()
            let base = "\(stamp(started))_to_\(stamp(nominalEnd))_\(streamName)_\(token)"
            let partial = day.appendingPathComponent(".\(base).inprogress.mp4")
            let final = day.appendingPathComponent("\(base).mp4")
            let manifest = day.appendingPathComponent("\(base).json")

            let candidate = try AVAssetWriter(outputURL: partial, fileType: .mp4)
            let compression: [String: Any] = [
                AVVideoAverageBitRateKey: bitrateKbps * 1_000,
                AVVideoExpectedSourceFrameRateKey: fps,
                AVVideoMaxKeyFrameIntervalKey: max(1, fps * 10),
                AVVideoAllowFrameReorderingKey: false,
            ]
            let color: [String: Any] = [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ]
            let settings: [String: Any] = [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: width,
                AVVideoHeightKey: height,
                AVVideoCompressionPropertiesKey: compression,
                AVVideoColorPropertiesKey: color,
            ]
            let candidateInput = AVAssetWriterInput(mediaType: .video,
                                                     outputSettings: settings)
            candidateInput.expectsMediaDataInRealTime = true
            guard candidate.canAdd(candidateInput) else {
                recordError("H.264 archive input is unsupported", failedSegment: true)
                return false
            }
            candidate.add(candidateInput)
            let sourceAttributes: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
            ]
            let candidateAdaptor = AVAssetWriterInputPixelBufferAdaptor(
                assetWriterInput: candidateInput,
                sourcePixelBufferAttributes: sourceAttributes)
            guard candidate.startWriting() else {
                recordError("cannot start MP4 archive: " +
                            (candidate.error?.localizedDescription ?? "unknown writer error"),
                            failedSegment: true)
                return false
            }
            candidate.startSession(atSourceTime: .zero)
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o600], ofItemAtPath: partial.path)

            writer = candidate
            input = candidateInput
            adaptor = candidateAdaptor
            partialURL = partial
            finalURL = final
            manifestURL = manifest
            segmentStartedAt = started
            segmentFirstSourceFrame = sourceFramesSeen
            segmentLastSourceFrame = sourceFramesSeen
            framesInSegment = 0
            statsLock.lock()
            pausedForLowSpace = false
            lastError = nil
            statsLock.unlock()
            return true
        } catch {
            recordError("cannot initialize MP4 archive: \(error.localizedDescription)",
                        failedSegment: true)
            return false
        }
    }

    func append(_ pixelBuffer: CVPixelBuffer) {
        sourceFramesSeen += 1
        if writer == nil {
            guard beginSegment(width: CVPixelBufferGetWidth(pixelBuffer),
                               height: CVPixelBufferGetHeight(pixelBuffer)) else { return }
        }
        guard let writer, let input, let adaptor else { return }
        guard input.isReadyForMoreMediaData else {
            statsLock.lock()
            backpressureDrops += 1
            statsLock.unlock()
            return
        }
        let presentationTime = CMTime(value: CMTimeValue(framesInSegment),
                                      timescale: CMTimeScale(fps))
        guard adaptor.append(pixelBuffer, withPresentationTime: presentationTime) else {
            recordError("cannot append archive frame: " +
                        (writer.error?.localizedDescription ?? "unknown writer error"))
            if writer.status == .failed {
                input.markAsFinished()
                self.writer = nil
                self.input = nil
                self.adaptor = nil
                framesInSegment = 0
                recordError("MP4 segment failed; partial file retained", failedSegment: true)
            }
            return
        }
        framesInSegment += 1
        segmentLastSourceFrame = sourceFramesSeen
        if framesInSegment >= segmentFrames {
            finishSegment()
        }
    }

    private func finishSegment() {
        guard let writer, let input,
              let partialURL, let finalURL, let manifestURL,
              let startedAt = segmentStartedAt else { return }
        let frameCount = framesInSegment
        let firstSourceFrame = segmentFirstSourceFrame
        let lastSourceFrame = segmentLastSourceFrame
        let duration = CMTime(value: CMTimeValue(frameCount),
                              timescale: CMTimeScale(fps))
        writer.endSession(atSourceTime: duration)
        input.markAsFinished()

        self.writer = nil
        self.input = nil
        self.adaptor = nil
        self.partialURL = nil
        self.finalURL = nil
        self.manifestURL = nil
        self.segmentStartedAt = nil
        self.framesInSegment = 0
        statsLock.lock()
        finishingSegments += 1
        statsLock.unlock()

        writer.finishWriting { [self] in
            statsLock.lock()
            finishingSegments -= 1
            statsLock.unlock()
            guard writer.status == .completed else {
                recordError("MP4 finalization failed; partial file retained: " +
                            (writer.error?.localizedDescription ?? "unknown writer error"),
                            failedSegment: true)
                return
            }
            do {
                try FileManager.default.moveItem(at: partialURL, to: finalURL)
                try? FileManager.default.setAttributes(
                    [.posixPermissions: 0o600], ofItemAtPath: finalURL.path)
            } catch {
                recordError("cannot publish completed MP4: \(error.localizedDescription)",
                            failedSegment: true)
                return
            }

            let endedAt = Date()
            let iso = ISO8601DateFormatter()
            let manifest: [String: Any] = [
                "schemaVersion": 1,
                "kind": "tinkystream-five-minute-archive",
                "stream": streamName,
                "videoFile": finalURL.lastPathComponent,
                "startedAt": iso.string(from: startedAt),
                "finalizedAt": iso.string(from: endedAt),
                "nominalDurationSeconds": segmentSeconds,
                "fps": fps,
                "frameCount": frameCount,
                "sourceFrameFirst": firstSourceFrame,
                "sourceFrameLast": lastSourceFrame,
                "codec": "h264",
                "container": "mp4",
                "bitrateKbps": bitrateKbps,
            ]
            do {
                let data = try JSONSerialization.data(
                    withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
                try data.write(to: manifestURL, options: .atomic)
                try? FileManager.default.setAttributes(
                    [.posixPermissions: 0o600], ofItemAtPath: manifestURL.path)
            } catch {
                recordError("MP4 saved but manifest failed: \(error.localizedDescription)")
            }
            statsLock.lock()
            completedSegments += 1
            lastCompletedPath = finalURL.path
            statsLock.unlock()
        }
    }

    func status() -> [String: Any] {
        statsLock.lock()
        let result: [String: Any] = [
            "enabled": true,
            "directory": root.path,
            "segmentSeconds": segmentSeconds,
            "segmentFrames": segmentFrames,
            "minimumFreeBytes": minimumFreeBytes,
            "bitrateKbps": bitrateKbps,
            "activeFrames": framesInSegment,
            "finishingSegments": finishingSegments,
            "completedSegments": completedSegments,
            "failedSegments": failedSegments,
            "backpressureDrops": backpressureDrops,
            "lowSpaceSkippedFrames": lowSpaceSkippedFrames,
            "pausedForLowSpace": pausedForLowSpace,
            "lastCompletedPath": lastCompletedPath ?? NSNull(),
            "lastError": lastError ?? NSNull(),
        ]
        statsLock.unlock()
        return result
    }
}

final class StreamSink: NSObject, SCStreamOutput, SCStreamDelegate {
    private let dir: URL
    private let ring: Int
    private let quality: CGFloat
    private let archive: StreamArchiveWriter?
    // Output basename (e.g. "latest.jpg" for the full mirror, "seethrough-latest.jpg"
    // for the Chrome-excluded see-through mirror). Lets one process run two streams
    // to two distinct frame files without clobbering each other.
    private let latestName: String
    private let tmpName: String
    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private let colorSpace = CGColorSpaceCreateDeviceRGB()
    // ScreenCaptureKit invokes output and stop callbacks on different queues,
    // while heartbeats and the recovery watchdog read this state concurrently.
    // Keep the counters and retry generations behind one small lock instead of
    // relying on unsynchronised Int reads.
    private let stateLock = NSLock()
    private var frameCount = 0
    private var failureCount = 0
    private var stopGeneration = 0
    private var recoveredThroughStopGeneration = 0
    private var attemptStartedUptime = ProcessInfo.processInfo.systemUptime
    private var framesAtAttemptStart = 0
    private var lastStopUptime: TimeInterval?

    var frames: Int {
        stateLock.lock(); defer { stateLock.unlock() }
        return frameCount
    }

    var writeFailures: Int {
        stateLock.lock(); defer { stateLock.unlock() }
        return failureCount
    }

    init(dir: URL, ring: Int, quality: CGFloat, latestName: String = "latest.jpg",
         archive: StreamArchiveWriter? = nil) {
        self.dir = dir
        self.ring = ring
        self.quality = quality
        self.latestName = latestName
        self.archive = archive
        // Distinct tmp per output so the two streams' atomic writes never race.
        self.tmpName = ".\(latestName).tmp"
    }

    // Called before every SCShareableContent request. The returned generation
    // binds this exact attempt to any delegate stop it is recovering from.
    func captureAttemptBegan() -> Int {
        stateLock.lock(); defer { stateLock.unlock() }
        attemptStartedUptime = ProcessInfo.processInfo.systemUptime
        framesAtAttemptStart = frameCount
        return stopGeneration
    }

    func captureStarted(recovering generation: Int) {
        stateLock.lock(); defer { stateLock.unlock() }
        recoveredThroughStopGeneration = max(recoveredThroughStopGeneration, generation)
    }

    func currentStopGeneration() -> Int {
        stateLock.lock(); defer { stateLock.unlock() }
        return stopGeneration
    }

    // A newly started stream must deliver at least one frame, and a delegate
    // stop must be followed by a successfully started replacement. If either
    // condition remains unresolved, the process-level watchdog lets launchd
    // provide a clean ScreenCaptureKit process after the OS has wedged an async
    // content request. Static screens are safe: once an attempt has delivered
    // its first frame, no ongoing frame-rate assumption is made.
    func recoveryReason(nowUptime: TimeInterval, timeout: TimeInterval) -> String? {
        stateLock.lock(); defer { stateLock.unlock() }
        if let stoppedAt = lastStopUptime,
           stopGeneration > recoveredThroughStopGeneration,
           nowUptime - stoppedAt >= timeout {
            return "delegate stop generation \(stopGeneration) was not recovered"
        }
        if frameCount == framesAtAttemptStart,
           nowUptime - attemptStartedUptime >= timeout {
            return "capture attempt produced no first frame"
        }
        return nil
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .screen,
              sampleBuffer.isValid,
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        archive?.append(pixelBuffer)
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        let qualityKey = CIImageRepresentationOption(
            rawValue: kCGImageDestinationLossyCompressionQuality as String)
        guard let jpeg = ciContext.jpegRepresentation(
            of: image, colorSpace: colorSpace, options: [qualityKey: quality]) else {
            stateLock.lock(); failureCount += 1; stateLock.unlock()
            return
        }
        let tmp = dir.appendingPathComponent(tmpName)
        let latest = dir.appendingPathComponent(latestName)
        do {
            try jpeg.write(to: tmp)
            _ = try FileManager.default.replaceItemAt(latest, withItemAt: tmp)
            stateLock.lock()
            let ringIndex = frameCount
            stateLock.unlock()
            if ring > 0 {
                try? jpeg.write(to: dir.appendingPathComponent(
                    String(format: "frame-%04d.jpg", ringIndex % ring)))
            }
            stateLock.lock(); frameCount += 1; stateLock.unlock()
        } catch {
            stateLock.lock(); failureCount += 1; stateLock.unlock()
        }
    }

    func archiveStatus() -> [String: Any] {
        archive?.status() ?? ["enabled": false]
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        stateLock.lock()
        stopGeneration += 1
        lastStopUptime = ProcessInfo.processInfo.systemUptime
        let generation = stopGeneration
        stateLock.unlock()
        let payload = ["ok": false, "error": "stream stopped: \(error.localizedDescription)"] as [String: Any]
        if let data = try? JSONSerialization.data(withJSONObject: payload),
           let s = String(data: data, encoding: .utf8) {
            FileHandle.standardError.write(Data((s + "\n").utf8))
        }
        // Do not exit directly from ScreenCaptureKit's delegate queue. An
        // immediate launchd relaunch can race the OS teardown and leave the new
        // process suspended forever inside SCShareableContent. runStream sees
        // this generation and retries after a short teardown delay; the
        // process watchdog remains the bounded fallback if that retry wedges.
        jsonOut(["ok": false, "recovering": true,
                 "stopGeneration": generation])
        fflush(stdout)
    }
}

func streamSessionIsLocked() -> Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else {
        return false
    }
    return (session["CGSSessionScreenIsLocked"] as? Bool) == true
}

func startStreamRecoveryWatchdog(_ sinks: [(label: String, sink: StreamSink)],
                                 timeoutSeconds: TimeInterval = 45.0) {
    Task {
        while true {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            if streamSessionIsLocked() { continue }
            let now = ProcessInfo.processInfo.systemUptime
            for entry in sinks {
                guard let reason = entry.sink.recoveryReason(
                    nowUptime: now, timeout: timeoutSeconds) else { continue }
                let payload: [String: Any] = [
                    "ok": false,
                    "fatalRecoveryRestart": true,
                    "stream": entry.label,
                    "error": reason,
                    "timeoutSeconds": timeoutSeconds,
                ]
                if let data = try? JSONSerialization.data(withJSONObject: payload),
                   let line = String(data: data, encoding: .utf8) {
                    FileHandle.standardError.write(Data((line + "\n").utf8))
                }
                exit(4)
            }
        }
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

// ScreenCaptureKit's `displays.first` follows the current main display. That is
// unsafe for GhostBridge: entering split mode deliberately makes the synthetic
// 960x1080 "GhostBridge Half" workspace main, while the actual 1920x1080 DELL
// panel contains the composed Mac + Windows view. Resolve the owner-configured
// physical display by its stable NSScreen name and fail closed if it is absent;
// never silently fall back to whichever synthetic display happens to be first.
func screenName(for display: SCDisplay) -> String? {
    NSScreen.screens.first { screen in
        guard let number = screen.deviceDescription[
            NSDeviceDescriptionKey("NSScreenNumber")
        ] as? NSNumber else { return false }
        return CGDirectDisplayID(number.uint32Value) == display.displayID
    }?.localizedName
}

func selectStreamDisplay(_ displays: [SCDisplay], named requestedName: String) -> SCDisplay? {
    let wanted = requestedName.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !wanted.isEmpty else { return nil }
    return displays.first { display in
        guard let candidate = screenName(for: display) else { return false }
        return candidate.compare(wanted, options: [.caseInsensitive, .diacriticInsensitive])
            == .orderedSame
    }
}

func availableStreamDisplayNames(_ displays: [SCDisplay]) -> String {
    displays.map { display in
        let name = screenName(for: display) ?? "unnamed"
        return "\(name)[id=\(display.displayID),\(display.width)x\(display.height)]"
    }.joined(separator: ",")
}

// One retry-alive capture loop writing to `sink`. Optionally excludes apps
// (see-through). When excluding, the filter is refreshed on each heartbeat so
// target apps launching/quitting after start are still handled.
func runStream(sink: StreamSink, label: String, outDir: String,
               fps: Int, scale: Double, ring: Int,
               displayName: String,
               excludeBundleIDs: Set<String>,
               hold: @escaping (SCStream) -> Void,
               release: @escaping (SCStream) -> Void) async {
    var attempt = 0
    while true {
        attempt += 1
        let recoveringGeneration = sink.captureAttemptBegan()
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: false)
            guard let display = selectStreamDisplay(content.displays,
                                                    named: displayName) else {
                throw NSError(domain: "tinky.stream", code: 3, userInfo: [
                    NSLocalizedDescriptionKey:
                        "physical display \(displayName) unavailable; available=" +
                        availableStreamDisplayNames(content.displays)])
            }
            let config = SCStreamConfiguration()
            config.width = max(64, Int(Double(display.width) * scale)) / 2 * 2
            config.height = max(64, Int(Double(display.height) * scale)) / 2 * 2
            config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
            config.pixelFormat = kCVPixelFormatType_32BGRA
            // Normalize both full and see-through capture buffers before JPEG
            // encoding. This avoids inheriting a transient display ICC profile
            // from either the physical panel or GhostBridge's virtual display.
            config.colorSpaceName = CGColorSpace.sRGB
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
            sink.captureStarted(recovering: recoveringGeneration)
            jsonOut(["ok": true, "streaming": true, "stream": label, "dir": outDir,
                     "fps": fps, "scale": scale, "ring": ring,
                     "excludes": Array(excludeBundleIDs).sorted(),
                     "displayID": display.displayID,
                     "displayName": screenName(for: display) ?? displayName,
                     "colorSpace": "sRGB",
                     "archive": sink.archiveStatus(),
                     "width": config.width, "height": config.height,
                     "grantedAfterAttempts": attempt])
            fflush(stdout)
            var nextHeartbeatUptime = ProcessInfo.processInfo.systemUptime + 5.0
            while true {
                try await Task.sleep(nanoseconds: 1_000_000_000)
                if sink.currentStopGeneration() > recoveringGeneration {
                    jsonOut(["ok": false, "recovering": true, "stream": label,
                             "attempt": attempt,
                             "stopGeneration": sink.currentStopGeneration()])
                    fflush(stdout)
                    try? await stream.stopCapture()
                    release(stream)
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    break
                }
                // Heartbeats stay at their established five-second cadence
                // even though stop recovery is polled once per second.
                let nowUptime = ProcessInfo.processInfo.systemUptime
                if nowUptime < nextHeartbeatUptime { continue }
                nextHeartbeatUptime = nowUptime + 5.0
                jsonOut(["ok": true, "heartbeat": true, "stream": label,
                         "frames": sink.frames, "writeFailures": sink.writeFailures,
                         "archive": sink.archiveStatus()])
                fflush(stdout)
                // Refresh the exclusion filter so Chrome windows opened after the
                // stream started are still excluded (and quit ones stop being).
                if !excludeBundleIDs.isEmpty,
                   let fresh = try? await SCShareableContent.excludingDesktopWindows(
                       false, onScreenWindowsOnly: false),
                   let disp = selectStreamDisplay(fresh.displays,
                                                  named: displayName) {
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
    let fps = max(1, min(60, Int(args.opts["fps"] ?? "1") ?? 1))
    let scale = min(1.0, max(0.1, Double(args.opts["scale"] ?? "0.5") ?? 0.5))
    let quality = min(1.0, max(0.1, Double(args.opts["quality"] ?? "0.6") ?? 0.6))
    let ring = max(0, Int(args.opts["ring"] ?? "0") ?? 0)
    let archiveSegmentSeconds = max(
        1, min(86_400, Int(args.opts["archive-segment-seconds"] ?? "300") ?? 300))
    let archiveMinimumFreeGB = max(
        1.0, Double(args.opts["archive-min-free-gb"] ?? "15") ?? 15.0)
    let archiveBitrateKbps = max(
        100, min(20_000, Int(args.opts["archive-bitrate-kbps"] ?? "500") ?? 500))
    let archiveRoot: URL? = args.opts["archive-dir"].flatMap { raw in
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return URL(fileURLWithPath: NSString(string: trimmed).expandingTildeInPath,
                   isDirectory: true)
    }
    guard let rawDisplayName = args.opts["display-name"] else {
        jsonErr("stream requires --display-name <physical display name>")
    }
    let displayName = rawDisplayName.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !displayName.isEmpty else {
        jsonErr("stream --display-name must not be empty")
    }
    // See-through: apps to make invisible in a SECOND frame (seethrough-latest.jpg).
    // Comma-separated bundle IDs; empty disables the second stream. The primary
    // latest.jpg is ALWAYS the full frame so Chrome vision/task paths keep working.
    let excludeBundleIDs = Set(
        (args.opts["exclude-app"] ?? "")
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty })
    // A slower see-through fps keeps two concurrent captures light on the GPU.
    let seethroughFps = max(1, min(fps, Int(args.opts["seethrough-fps"] ?? "1") ?? 1))
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
    let release: (SCStream) -> Void = { s in
        retainLock.lock(); retained.removeAll { $0 === s }; retainLock.unlock()
    }

    let minimumFreeBytes = Int64(archiveMinimumFreeGB * 1_073_741_824.0)
    let archive = archiveRoot.map {
        StreamArchiveWriter(root: $0, streamName: "full", fps: fps,
                            segmentSeconds: archiveSegmentSeconds,
                            minimumFreeBytes: minimumFreeBytes,
                            bitrateKbps: archiveBitrateKbps)
    }
    let primary = StreamSink(dir: dir, ring: ring, quality: CGFloat(quality),
                             archive: archive)
    var recoverySinks: [(label: String, sink: StreamSink)] = [("full", primary)]
    Task {
        await runStream(sink: primary, label: "full", outDir: outDir, fps: fps,
                        scale: scale, ring: ring, displayName: displayName,
                        excludeBundleIDs: [], hold: hold, release: release)
    }
    if !excludeBundleIDs.isEmpty {
        let seethrough = StreamSink(dir: dir, ring: 0, quality: CGFloat(quality),
                                    latestName: "seethrough-latest.jpg")
        recoverySinks.append(("seethrough", seethrough))
        Task {
            await runStream(sink: seethrough, label: "seethrough", outDir: outDir,
                            fps: seethroughFps, scale: scale, ring: 0,
                            displayName: displayName,
                            excludeBundleIDs: excludeBundleIDs,
                            hold: hold, release: release)
        }
    }
    startStreamRecoveryWatchdog(recoverySinks)
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
    if let v = env["TINKY_STREAM_DISPLAY_NAME"] { opts["display-name"] = v }
    if let v = env["TINKY_STREAM_ARCHIVE_DIR"] { opts["archive-dir"] = v }
    if let v = env["TINKY_STREAM_ARCHIVE_SEGMENT_SECONDS"] {
        opts["archive-segment-seconds"] = v
    }
    if let v = env["TINKY_STREAM_ARCHIVE_MIN_FREE_GB"] {
        opts["archive-min-free-gb"] = v
    }
    if let v = env["TINKY_STREAM_ARCHIVE_BITRATE_KBPS"] {
        opts["archive-bitrate-kbps"] = v
    }
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
case "type":         cmdType(args)
case "key":          cmdKey(args)
case "apps":           cmdApps(args)
case "find-window":    cmdFindWindow(args)
case "focused-window": cmdFocusedWindow(args)
case "find-text":      cmdFindText(args)
case "ax-tree":        cmdAXTree(args)
case "ax-check":       cmdAXCheck(args)
case "scoped-ax":
    MainActor.assumeIsolated { ScopedAXRuntime.run(arguments: Array(CommandLine.arguments.dropFirst(2))) }
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
      scoped-ax --session-id <uuid> [--read-only] [--deny-bundle <bundleID>]
      stream --out <dir> --display-name <physical display name>
             [--fps <1-60>] [--scale <0.1-1>] [--quality <0.1-1>] [--ring <n>]
             [--archive-dir <dir>] [--archive-segment-seconds <n>]
             [--archive-min-free-gb <n>] [--archive-bitrate-kbps <n>]
             [--exclude-app <bundleID,…>] [--seethrough-fps <1-60>]
             # --archive-dir saves timestamped H.264 MP4 segments without pruning;
             # archival pauses at the free-space reserve while the live ring continues.
             # --exclude-app writes a second see-through frame (seethrough-latest.jpg)
             # with those apps excluded from the composite — invisible in the mirror,
             # untouched on the real screen. latest.jpg stays the full frame.
    """)
default:
    jsonErr("Unknown command '\(args.cmd)'. Run `tinky-os help`.")
}
