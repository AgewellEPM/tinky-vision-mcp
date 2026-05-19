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

// MARK: - Main

let args = Args.parse(CommandLine.arguments)
switch args.cmd {
case "screenshot":   cmdScreenshot(args)
case "click":        cmdClick(args)
case "type":         cmdType(args)
case "key":          cmdKey(args)
case "apps":           cmdApps(args)
case "find-window":    cmdFindWindow(args)
case "focused-window": cmdFocusedWindow(args)
case "find-text":      cmdFindText(args)
case "ax-check":       cmdAXCheck(args)
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
      ax-check
    """)
default:
    jsonErr("Unknown command '\(args.cmd)'. Run `tinky-os help`.")
}
