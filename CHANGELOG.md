# Changelog

All notable changes to **tinky-vision-mcp** are documented here. Format
loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is [SemVer](https://semver.org/).

## [0.1.3] — 2026-07-19

### Security
- **Self-substrate content guard (machine-freeze protection).** Hard,
  consent-unbypassable refusal of any write whose payload is a self-restart of
  the Kist runtime the agent lives in. Added after a 2026-07-09 incident where an
  agent typed+approved `launchctl kickstart` on its own service and the
  KeepAlive respawn loop froze the machine. Checks the cheap hot-path signals
  (typed text + action label), not per-keystroke OCR.
- Prefer the accessibility helper binary `bin/tinky-os-ax` when present, falling
  back to `bin/tinky-os`; Swift helper (`main.swift`) gains the AX path.

### Notes
- Reconciles the deployed runtime copy (which carried the guard) back into this
  canonical repo — both had drifted while sharing the `0.1.2` version string.
  This is that fix, versioned honestly.

## [0.1.2] — 2026-05-19

### Added (operations)

- **Audit-log rotation.** Previously `session.jsonl` grew unbounded
  forever; a busy session would silently consume megabytes of disk
  per day. Now rotates when the file exceeds `TINKY_AUDIT_ROTATE_MAX`
  bytes (default 5MB) — renames to `session.<iso-ts>.jsonl` and starts
  fresh. Keeps the last `TINKY_AUDIT_KEEP_FILES` archives (default 5).
  Rotation runs at most every 100 appends so the size-check is cheap.
- **`TINKY_AUDIT_DISABLE=1`** env var — suppresses all log writes for
  CI / ephemeral / test rigs.
- Two new tests (`tests/server.test.mjs`) covering both the rotation
  threshold + the disable knob. Total: 13 → 15.

### Changed

- File-top docblock label bumped to v0.1.2 + rotation behavior
  documented inline alongside the existing audit-redaction policy.

## [0.1.1] — 2026-05-19

### Security (3 HIGH + 1 MEDIUM findings closed)

After a 4-round Codex security review, three HIGH-severity issues
shipped fixed in this release:

- **HIGH#1 — Audit-log credential leak.** Previous `audit()` persisted
  raw `os_type` text payloads to `session.jsonl`, including any
  passwords / MFA codes typed through the helper. Time-Machine,
  Spotlight, and iCloud Library backups would have silently
  propagated the cleartext.
  - Added `SECRET_ARG_KEYS` allowlist + `redactArgsForAudit()`. `text`
    is replaced with `[REDACTED:Nch]` before any write to the log.

- **HIGH#2 — Deny-list silently fails open when focus is unknown.**
  Previous `focusedBundleID()` collapsed "helper failure" and "no
  focused window" into `null`. `enforceDenyList()`'s
  `if (bundle && DENY_BUNDLES.has(bundle))` then passed through and
  the write tool succeeded. An adversary could trigger this by any
  transient helper failure.
  - `focusedBundleID()` now returns `{bundleID}` or `{error}`.
    `enforceDenyList()` throws on any non-positive identification.
    False-positive cost = retry in 2s. False-negative cost = agent
    typing a master password into a notes app.

- **HIGH#3 — Approval cache keyed on AI-claimed target only.**
  Previous `approvedTargets` cached by `target` string. After Safari
  was approved for `target='Safari'`, focus silently shifting to a
  different app (or a prompt-injected agent reusing the same target
  string) bypassed the consent prompt entirely.
  - Approval key is now `${observedBundle}::${target}`. Any change in
    either dimension re-prompts. `requestConsent()` also hard-rejects
    when `observedBundle` is null (defense-in-depth on top of HIGH#2).

- **MEDIUM — ARIA `state[]` markers not consulted.** `isSecretField`
  now checks the `state` array for `password`, `protected`,
  `sensitive`, `secure`, `secret` markers.

### Added

- `vision_find_text` MCP tool — on-device OCR via macOS Vision
  framework. Returns text + bounding boxes in both pixel and screen-
  point coords for direct hand-off to `os_click`.
- `os_focused_window` MCP tool — public read-only access to the same
  data the deny-list uses internally. Lets the AI verify which app a
  click will land in BEFORE calling `os_click`.
- `find-text` + `focused-window` Swift subcommands in the helper.
- `TINKY_AUTO_APPROVE=1` env var — bypasses the consent dialog for
  non-interactive testing. NEVER on by default. README documents
  this as a foot-gun.
- `TINKY_HELPER_BIN=<path>` env var — points the server at a fake
  helper script for hermetic integration testing. Used by the
  10-test suite at `tests/server.test.mjs`.
- Sensitive-app deny-list (13 default bundles + `TINKY_DENY_BUNDLES`
  extension).

### Changed

- Tool count grew 7 → 9.
- Test count grew 10 → 13 (3 new SEC regressions).
- README rewrote the security section to reflect the actual gate
  ordering + fail-closed semantics, replacing the prior
  "don't run against 1Password" warning that understated what's now
  shipped.

## [0.1.0] — 2026-05-18

Initial PROTOTYPE release. 7 tools, 10 integration tests.
