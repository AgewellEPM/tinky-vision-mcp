# tinky-vision-mcp

**PROTOTYPE — do not run against production logins, banking, or
1Password-style apps. This server can click anywhere and type
anything. Treat it like sudo for your screen.**

Local [Model Context Protocol](https://modelcontextprotocol.io/) server
that bridges modern AI clients (Claude Desktop, Claude Code, Cursor,
any MCP host) to **legacy macOS apps** that have no native AI API.

The legacy app has no idea it's being driven by an AI. It just sees a
fast human moving the mouse and typing on the keyboard.

```
┌─────────────────┐   stdio    ┌──────────────────┐   spawn   ┌──────────┐
│ Claude Desktop  │◄─JSON-RPC─►│ tinky-vision-mcp │──────────►│ tinky-os │
│ (or any MCP     │            │ (Node.js server) │           │ (Swift)  │
│  client)        │            └──────────────────┘           └────┬─────┘
└─────────────────┘                                                │
                                                                   ▼
                                                       CGEvent · AX · screencapture
                                                                   │
                                                                   ▼
                                                          ANY macOS app
                                                          (1998 or 2026)
```

## Tools

| Tool | Side effect | Description |
|---|---|---|
| `os_screenshot` | read-only | PNG of screen or specific app window |
| `os_list_apps` | read-only | All running regular `.app` processes with bundle IDs |
| `os_find_window` | read-only | Search visible windows by title/owner substring |
| `os_focused_window` | read-only | Frontmost app's bundle ID + key-window bounds |
| `vision_find_text` | read-only | On-device OCR (macOS Vision) over the screen; returns text + clickable coords |
| `os_ax_check` | read-only | Is Accessibility permission granted? |
| `os_click` | **write** | Synthetic mouse click at screen coords |
| `os_type` | **write** | Type text at currently-focused field |
| `os_key` | **write** | Press a key with optional Cmd/Shift/Opt/Ctrl |

Every write tool runs through three gates, in order:
1. **Read-only check** — server started with `--read-only` blocks all writes
2. **Sensitive-app deny-list** — hard policy block when the focused window
   belongs to 1Password / Bitwarden / LastPass / Dashlane / Keychain /
   SecurityAgent / Touch-ID prompt / Terminal / iTerm / Screen Sharing /
   System Settings. Cannot be opted past inside a session. Extend via the
   `TINKY_DENY_BUNDLES` env var (colon-separated).
3. **Consent dialog** — first call per `target` per session pops a native
   macOS dialog showing the AI's described action AND the observed
   focused-app bundle (so target/reality mismatches are visible).

The deny-list is intentionally stricter than the consent prompt because
prompt-injection attacks teach AIs to lie about what they're doing.
Policy blocks the action before the dialog ever shows.

## Install

```bash
git clone https://github.com/AgewellEPM/tinky-vision-mcp.git
cd tinky-vision-mcp
npm install
npm run build:helper   # builds the Swift CLI + copies to bin/
npm test               # run the 10-test policy + integration suite
```

### Grant Accessibility to the helper

The first time you call `os_click` / `os_type` / `os_key` the call
will fail with an Accessibility error. Open
**System Settings → Privacy & Security → Accessibility**, click `+`,
and add `bin/tinky-os` from this repo. Toggle it ON.

If you rebuild the helper, the binary path changes — you may need to
remove the old entry and re-add the new one. (Yes, this is a macOS
TCC quirk, not our bug.)

### Wire into Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tinky-vision": {
      "command": "node",
      "args": [
        "/Users/YOU/tinky-vision-mcp/src/server.mjs"
      ]
    }
  }
}
```

For a **read-only** server (no write tools loaded at all — useful for
"just look at my screen and tell me what you see"):

```json
"args": ["/Users/YOU/tinky-vision-mcp/src/server.mjs", "--read-only"]
```

Restart Claude Desktop. You should see `tinky-vision` in the MCP
servers panel.

### Wire into Claude Code

```bash
claude mcp add tinky-vision -- node /Users/YOU/tinky-vision-mcp/src/server.mjs
```

## Security model

This is the part to read.

### What this server CAN do

- See every pixel on your screen (via `os_screenshot`)
- Click anywhere on your screen (via `os_click`)
- Type anything into the focused field (via `os_type`)
- Press any key combo (via `os_key`)

Combined: an attacker with control of the AI client can exfiltrate
data, send messages as you, drain accounts, install software, or
disable security features.

### What protects you

1. **Accessibility permission must be granted manually.** macOS will
   not let `tinky-os` send synthetic input without your explicit OK
   in System Settings. Without it, every write tool silently no-ops.
2. **Per-target consent dialog on first action.** When the AI tries
   to click in Photoshop for the first time, you see a native macOS
   dialog: *"Claude wants to click the Play button on Steve's World.
   Approve once / Approve session / Deny."* You can deny.
3. **Per-target session scope.** "Approve session" approves further
   actions against THAT TARGET ONLY for the lifetime of the server
   process. New target → new dialog. Server restart → re-approve.
4. **Audit log.** Every tool call (success or failure) appended to
   `~/Library/Logs/tinky-vision-mcp/session.jsonl`. You can `tail -f`
   it during a session.
5. **`--read-only` mode.** Pass `--read-only` to disable all write
   tools at startup. The MCP host sees only the read tools.

### What does NOT protect you

- The AI itself. If the AI is jailbroken or prompt-injected (e.g. by
  a webpage you asked it to read), it WILL try to abuse these tools.
  The consent dialog is the only thing between you and that.
- Approving "session" without thinking. "Approve session" is a fire-
  and-forget grant — you won't see another dialog for that target
  until the server restarts. Use "Approve once" if you're paranoid.
- Reading data. Screenshots are unprompted (read-only ≠ harmless).
  Don't run this with a 1Password window open and visible.

### Recommendations

- Keep `--read-only` on by default. Turn write mode on only when you
  need it.
- Quit the server (or kill Claude Desktop) when you're not actively
  driving an app. The session approval list dies with the process.
- Review `~/Library/Logs/tinky-vision-mcp/session.jsonl` periodically.
- Don't run this on a machine that holds keys to anything you can't
  afford to lose. This is a prototype.

## Architecture

`src/server.mjs` — Node.js MCP server. Owns:
- MCP JSON-RPC over stdio
- Tool registration + dispatch
- Consent gate (osascript dialog)
- Audit log (jsonl append)

`swift-helper/Sources/TinkyOS/main.swift` — Swift CLI. Owns:
- `screencapture` invocation
- `CGEvent` posting (clicks + key presses)
- `AXIsProcessTrusted` checks
- `CGWindowList` enumeration
- `NSWorkspace.runningApplications`

The split exists because:
- Node has the most mature MCP SDK
- Swift gets us the lowest-friction path to macOS primitives
- Communicating over stdin/stdout (one spawn per tool call) is
  cheap enough for human-paced agent action loops

## Building

```bash
# helper
cd swift-helper && swift build -c release
# OR from the repo root:
npm run build:helper
```

The Swift binary lands at `bin/tinky-os` — that's the path
`src/server.mjs` looks for at startup.

## License

MIT (the code). Your responsibility to use it safely (everything else).

## Made by

Luke Kist · [Age Well Alliance / TinkyTown](https://tinkysales.vercel.app)
