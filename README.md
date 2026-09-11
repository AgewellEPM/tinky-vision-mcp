# TinkyVision + IsolatedTester

**Created by Luke Kist / TinkyBink · [AgewellEPM](https://github.com/AgewellEPM)**

Screen understanding and isolated app testing over MCP. Connect an AI assistant to macOS applications through screenshots, on-device OCR, accessibility elements, and explicit input tools. IsolatedTester adds virtual-display app sessions, ASCII frames for text-only models, bounded visual history, and evidence reports.

**Early-access release 0.2.0.** The packages target Apple silicon Macs running macOS 14 or later. This project is independently developed; an Anthropic listing or endorsement is not claimed. Clean-install Claude Desktop UI acceptance remains pending. See [release validation](docs/RELEASE-VALIDATION.md).

## Install

Download the two companion extensions from [the 0.2.0 release](https://github.com/AgewellEPM/tinky-vision-mcp/releases/tag/v0.2.0):

- **tinkyvision-0.2.0-macos-arm64.mcpb** — screen capture, OCR, window discovery, scoped accessibility, and consent-gated control. Includes the Swift helpers and Node dependencies; Claude Desktop supplies Node.
- **isolated-tester-1.2.1-macos-arm64.mcpb** — isolated app sessions, screenshots, OCR/ASCII frames, accessibility, input, recording controls, and reports. Includes its native MCP executable.

Install both through Claude Desktop's extension installation UI. Grant the requested macOS Screen Recording and Accessibility permissions to the relevant executables; permissions are machine-specific and cannot be bundled. TinkyVision starts in read-only mode by default; change its extension setting only when input control is intended. IsolatedTester exposes input tools whose use must be authorized by the operator.

The native artifacts are intended for Apple silicon. Intel, Windows-hosted, and Linux-hosted execution are not claimed. Windows guests require separately installed Perslis/GhostBridge and the exact licensed guest disk. Guest images are not distributed here.

Other MCP clients can extract the bundles and run the TinkyVision `src/server.mjs` with Node 20+ or the IsolatedTester `bin/isolated-mcp` executable over stdio. MCPB installation support varies by client.

## What the model receives

| Need | Tools |
|---|---|
| An image directly through MCP | `os_screenshot_image`, `session_image`, `portal_snapshot` |
| Recognized text and positions | `vision_find_text`, `ocr_frame` |
| Structured interface elements | `os_ax_snapshot`, `get_accessibility_tree`, `get_interactive_elements` |
| A spatial view for text-only models | `ascii_frame` |
| Captures saved on the Mac | `os_screenshot`, `session_frame`, `screenshot` |
| Inspect and manage isolated sessions | `setup_status`, `list_sessions`, `create_session`, `stop_session` |
| Review recorded evidence | `frame_history`, `seal_session`, `session_report`, `trend_report` |

A text-only model receives text representations, not native image perception. A file path is distinct from an MCP image response. Client configuration determines whether image/text results are sent to a hosted model.

## First session

1. Check `setup_status` and existing sessions. Run at most one isolated app or VM session.
2. Create a session for a disposable native test app, with a clear objective.
3. Observe through `session_image`, OCR, or accessibility before selecting input targets.
4. Verify the result through a fresh observation.
5. Stop the session in guaranteed cleanup and verify that its owned app/helpers are gone.

Keep continuous capture at or below 1 FPS and retain the 300-frame recycler. TinkyStream capture is available in the included helper/source; the extensions do not install a background recording service. GhostBridge portal tools require a separately configured active portal. They fail when that dependency is absent.

## Permissions and boundaries

TinkyVision preserves its sensitive-app deny list, read-only control, self-protection checks, native consent, and audit logging. Scoped accessibility grants bind to a specific window and expire. Read-only mode does not mean a tool has no privacy implications: screenshots and UI text can contain private information.

IsolatedTester places an app on a virtual display. This is UI isolation, not a filesystem, network, or operating-system security sandbox. The app and tools retain their OS-level permissions. An arbitrary click can activate a destructive application action. Tool annotations describe effects and do not replace operator authorization.

## Privacy Policy

Read the [Privacy Policy](PRIVACY.md) before connecting a client. It explains screen data, model-provider sharing, local logs, recordings, retention, and deletion. Optional autonomous tests can call Anthropic or OpenAI using the operator's credentials.

## Credit and citation

Please credit **Luke Kist / TinkyBink (AgewellEPM)** and link this repository when demonstrating or building on the system. Use [CITATION.cff](CITATION.cff) for a versioned software citation. Preserve the included notices for IsolatedTester contributors and third-party dependencies.

## Source and support

TinkyVision is MIT licensed; native helpers and build sources are in this repository. IsolatedTester is distributed with its MIT notice as a companion binary. [Support and bug reports](https://github.com/AgewellEPM/tinky-vision-mcp/issues). Do not post private screenshots, API keys, or session recordings in public issues.

Maintainer packaging and submission details: [release guide](docs/RELEASING.md), [reviewer instructions](docs/REVIEWER-GUIDE.md).
