# Reviewer instructions

Install both MCPB files on an Apple silicon Mac running macOS 14 or later. No publisher account is required for basic observation and manual tool-driven testing. Grant Screen Recording and Accessibility permissions when macOS requests them. Optional autonomous tests require the operator's model-provider credentials; remote portal tools require a separate GhostBridge installation/session.

Start with `setup_status` and `list_sessions`. Use one disposable native test app. Inspect its accessibility tree, OCR and ASCII output, and `session_image`; perform a harmless fixture operation and verify the observed result. Stop the session in guaranteed cleanup, then inspect its report. Use `os_screenshot_image` to test native MCP image delivery. TinkyVision input is disabled by default; enable it only for an explicitly authorized test and complete native consent.

Check error paths with an absent session, unavailable portal, and denied permissions. Do not bypass sensitive-app or self-protection refusals. Use no more than one isolated app/guest, keep capture at or below 1 FPS, and retain the 300-frame ring. Windows testing must use Perslis/GhostBridge and the exact already-installed licensed guest; no guest images are included.

Current validation and remaining limitations are recorded in RELEASE-VALIDATION.md. This release does not claim that every tool has passed a fresh Claude Desktop UI acceptance run.
