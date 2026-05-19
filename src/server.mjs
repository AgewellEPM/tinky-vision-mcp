#!/usr/bin/env node
// tinky-vision-mcp — Local MCP server that bridges modern AI clients
// (Claude Desktop, Claude Code, Cursor, etc.) to legacy macOS apps via
// vision + Accessibility.
//
// The legacy app has no idea it's being driven by an AI; it just sees
// a fast human moving the mouse + typing on the keyboard.
//
// Architecture:
//
//   MCP client (Claude) ──stdio JSON-RPC──> this server ──spawn──> tinky-os
//                                                                  (Swift CLI)
//                                                                       │
//                                                                       ▼
//                                                                  CGEvent / AX / screencapture
//
// Tools exposed (all macOS-host-only):
//   - os_screenshot         capture screen or app window
//   - os_list_apps          enumerate running regular .app processes
//   - os_find_window        search visible windows by title/owner
//   - os_click              mouse click at screen coords
//   - os_type               type text at focused field
//   - os_key                press a key with optional modifiers
//   - os_ax_check           report Accessibility permission state
//
// Security gate:
//   - Every WRITE tool (click/type/key) requires an OS-level approval
//     dialog on first call per target app per session, then auto-
//     allows for that app until the server restarts.
//   - Every call appended to ~/Library/Logs/tinky-vision-mcp/session.jsonl
//   - --read-only flag disables write tools entirely.
//
// LABEL: PROTOTYPE.

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// ────────────────────────── config ──────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
// HELPER_BIN can be overridden via env for tests (fake helper script
// that emits canned JSON). Default = the prebuilt Swift binary.
const HELPER_BIN = process.env.TINKY_HELPER_BIN ||
  resolve(__dirname, '..', 'bin', 'tinky-os');
const LOG_DIR = join(homedir(), 'Library', 'Logs', 'tinky-vision-mcp');
const LOG_FILE = join(LOG_DIR, 'session.jsonl');
const READ_ONLY = process.argv.includes('--read-only');

// AUTO_APPROVE bypasses the osascript dialog. Used by `npm test` and by
// power users who explicitly want non-interactive use. Documented as a
// foot-gun in the README. NEVER on by default.
const AUTO_APPROVE = process.env.TINKY_AUTO_APPROVE === '1';

// ────────────────────────── sensitive-app deny-list ──────────────────────────
//
// Hard block on write tools when the focused window belongs to a
// password manager, the macOS Keychain, the auth prompt, or any custom
// bundle the user added via TINKY_DENY_BUNDLES (colon-separated). This
// is policy, not consent — the user cannot opt past it inside a
// session. To allow a denied app, restart the server without the entry.
//
// Reasoning: a prompt-injected agent that can click + type inside
// 1Password / Keychain / browser-banking can drain accounts in seconds.
// The dialog gate is a speed bump; this is a wall.
const DEFAULT_DENY = new Set([
  'com.agilebits.onepassword7',         // 1Password 7
  'com.1password.1password',            // 1Password 8 (App Store)
  'com.1password.1password-launcher',
  'com.bitwarden.desktop',
  'com.lastpass.LastPassMacDesktop',
  'com.dashlane.dashlanephonefinal',
  'com.apple.keychainaccess',
  'com.apple.SecurityAgent',            // OS auth prompt
  'com.apple.LocalAuthentication.UIAgent', // Touch-ID / biometric prompt
  'com.apple.systempreferences',        // System Settings — too easy to wreck
  'com.apple.Terminal',                 // foot-gun: agent typing into terminal
  'com.googlecode.iterm2',
  'com.apple.ScreenSharing',
  'com.apple.security.pboxd',
]);
const EXTRA_DENY = (process.env.TINKY_DENY_BUNDLES || '')
  .split(':').map(s => s.trim()).filter(Boolean);
const DENY_BUNDLES = new Set([...DEFAULT_DENY, ...EXTRA_DENY]);

if (!existsSync(HELPER_BIN)) {
  console.error(
    `[tinky-vision-mcp] FATAL: tinky-os helper binary not found at ${HELPER_BIN}.\n` +
    `Run \`npm run build:helper\` from the repo root, or grab the prebuilt binary.`
  );
  process.exit(2);
}

mkdirSync(LOG_DIR, { recursive: true });

// ────────────────────────── audit log ──────────────────────────
//
// The audit log lives at ~/Library/Logs/tinky-vision-mcp/session.jsonl.
// It records EVERY tool call so Luke can prove (or disprove) what an
// agent did during a session. Because the helper types real keystrokes,
// the raw `text` argument of os_type can contain passwords, MFA codes,
// API tokens, etc. Codex finding HIGH#1 (2026-05-18): persisting that
// payload to a plaintext on-disk log is a local credential leak even
// without anyone breaching the box — Time-Machine, search-indexer, and
// cloud-backed Library backups will silently propagate it.
//
// Policy:
//   - For os_type:    drop `text` entirely; keep only length.
//   - For os_click/key: keep coords/key/mods; description+target are
//                       user-authored labels and safe to keep.
//   - For read tools: pass-through (no secrets in their args).
//
// If a future tool accepts secrets, add it to SECRET_ARG_KEYS so the
// redactor wipes them without us having to remember to do it manually.
const SECRET_ARG_KEYS = new Set(['text', 'password', 'token', 'secret', 'apiKey']);

function redactArgsForAudit(toolName, args) {
  if (!args || typeof args !== 'object') return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (SECRET_ARG_KEYS.has(k) && typeof v === 'string') {
      out[k] = `[REDACTED:${v.length}ch]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function audit(entry) {
  const safe = { ...entry };
  if (safe.args) safe.args = redactArgsForAudit(safe.tool, safe.args);
  const line = JSON.stringify({ ts: Date.now(), ...safe }) + '\n';
  try { appendFileSync(LOG_FILE, line); } catch { /* silent */ }
}

// ────────────────────────── helper invocation ──────────────────────────

/// Spawn tinky-os with args, parse the stdout JSON, return it. Throws
/// on non-zero exit. Stderr is captured into the thrown error.
function callHelper(subcmd, args = []) {
  const argv = [subcmd, ...args];
  try {
    const out = execFileSync(HELPER_BIN, argv, {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(out.trim() || '{}');
  } catch (e) {
    // tinky-os emits {"ok":false,"error":...} to stderr on failure.
    let parsed = null;
    if (e.stderr) {
      try { parsed = JSON.parse(String(e.stderr).trim()); } catch { /* ignore */ }
    }
    const msg = parsed?.error || e.message || 'helper invocation failed';
    const err = new Error(msg);
    err.code = e.status ?? -1;
    throw err;
  }
}

// ────────────────────────── consent gate ──────────────────────────

/// In-memory per-session allow list of approved (target, bundleID)
/// pairs the user has already approved for write actions. Cleared on
/// server restart so every new Claude conversation re-prompts.
///
/// Codex finding HIGH#3 (2026-05-18): keying approvals on the caller-
/// supplied `target` string alone let a prompt-injected agent reuse a
/// prior approval (e.g. "Safari") even after focus had silently moved
/// to 1Password / a banking tab / a different app. Now we key on the
/// OBSERVED focused-app bundle joined with the user-claimed target so
/// the cache only matches when reality and claim still agree.
const approvedTargets = new Set();
function approvalKey(target, bundleID) {
  return `${bundleID || '<unknown>'}::${target || '<none>'}`;
}

/// Look up the currently focused app's bundle ID.
///
/// Returns:
///   { bundleID: 'com.example.app' }  on success
///   { error: 'reason' }              on helper failure OR no focused app
///
/// We deliberately do NOT collapse "helper failed" and "no focused
/// window" into the same `null` return that callers might misread as
/// "safe to proceed" (Codex finding HIGH#2 — the previous version did
/// exactly that and the deny-list silently fell through).
function focusedBundleID() {
  try {
    const r = callHelper('focused-window');
    const id = r?.focused?.bundleID;
    if (id) return { bundleID: id };
    return { error: 'no focused app reported by helper' };
  } catch (e) {
    return { error: e?.message || 'focused-window helper call failed' };
  }
}

/// Hard deny-list enforcement. Throws on (a) helper failure, (b) no
/// focused app, or (c) focused app present in the deny-list. Run BEFORE
/// the consent dialog so the user never sees a "click in 1Password?"
/// prompt — that prompt would teach them to approve.
///
/// Fail-closed semantics (Codex HIGH#2): if we can't be certain the
/// focused app is safe, we block. The cost of a false-positive block
/// is "retry in 2 seconds"; the cost of a false-negative allow is
/// "agent typed your master password into a notes app".
function enforceDenyList(toolName) {
  const { bundleID, error } = focusedBundleID();
  if (error) {
    audit({ tool: toolName, deny: true, reason: 'focus-unknown', detail: error });
    throw new Error(
      `DENIED: cannot identify the currently focused app (${error}). ` +
      `Write tools are blocked when focus is uncertain because we cannot ` +
      `verify the target is not a password manager or auth prompt. ` +
      `Bring a regular app to the foreground (click into it) and retry.`
    );
  }
  if (DENY_BUNDLES.has(bundleID)) {
    audit({ tool: toolName, deny: true, focused: bundleID });
    throw new Error(
      `DENIED: focused app ${bundleID} is on the sensitive-app deny-list. ` +
      `Write tools (click/type/key) are blocked when these apps are frontmost. ` +
      `Switch focus to a non-sensitive app and retry, or restart the server ` +
      `with TINKY_DENY_BUNDLES set to remove the entry (not recommended).`
    );
  }
  return bundleID;
}

/// Ask the user via /usr/bin/osascript for permission to perform a
/// write action against `target`. Returns true on yes, false on no.
/// `description` is a short human-readable summary of what the AI
/// wants to do, shown verbatim in the dialog. Includes the OBSERVED
/// focused-app bundle so a mismatch between AI-claimed target and
/// reality is visible to the user.
///
/// Approval cache key (Codex HIGH#3): (observedBundle, target). An
/// approval granted while Safari was focused does NOT auto-extend to
/// 1Password — even though the agent's `target` string didn't change,
/// the observed bundle did. New (bundle, target) pair re-prompts.
function requestConsent(target, description, observedBundle) {
  if (READ_ONLY) return false;
  // observedBundle is REQUIRED by guardedWrite() — null/empty means the
  // deny-list check was bypassed somehow, fail closed.
  if (!observedBundle) return false;
  const key = approvalKey(target, observedBundle);
  if (approvedTargets.has(key)) return true;
  // AUTO_APPROVE bypass runs AFTER deny-list (caller already passed
  // enforceDenyList), AFTER null-bundle guard, but BEFORE the dialog.
  // Tests rely on it; humans should never enable it.
  if (AUTO_APPROVE) return true;
  const title = 'Tinky Vision MCP — Action approval';
  const detail =
    `Claude wants to perform an OS-level action:\n\n${description}` +
    `\n\nTarget (AI-claimed): ${target}` +
    `\nObserved focused app:  ${observedBundle}` +
    `\n\nApprove this action? "Approve session" remembers ONLY this exact ` +
    `(target × observed app) pair — if focus shifts to a different app, ` +
    `you will be re-prompted.`;
  const script = `
    set theResponse to display dialog ${JSON.stringify(detail)} with title ${JSON.stringify(title)} buttons {"Deny", "Approve once", "Approve session"} default button "Deny" with icon caution
    set btn to button returned of theResponse
    return btn
  `;
  try {
    const out = execFileSync('/usr/bin/osascript', ['-e', script], {
      encoding: 'utf8',
      timeout: 60_000,
    }).trim();
    if (out === 'Approve session') {
      approvedTargets.add(key);
      return true;
    }
    if (out === 'Approve once') return true;
    return false;
  } catch {
    return false;
  }
}

/// Shared guard for every write tool. Runs read-only check, deny-list,
/// consent, in that order. Returns the observed bundle on success;
/// throws on any block.
function guardedWrite(toolName, target, description) {
  if (READ_ONLY) throw new Error('Write tools disabled (--read-only).');
  const observedBundle = enforceDenyList(toolName);   // throws if uncertain or denied
  if (!requestConsent(target, description, observedBundle)) {
    throw new Error(`User denied consent for ${toolName}.`);
  }
  return observedBundle;
}

// ────────────────────────── tool defs ──────────────────────────

const TOOLS = [
  {
    name: 'os_screenshot',
    description:
      'Capture a screenshot of the macOS screen or a specific app window. Returns the file path of the PNG. Use this to SEE what is currently on screen before reasoning about clicks. Safe — no consent prompt; screenshots are read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        bundleId: {
          type: 'string',
          description: 'Optional macOS bundle ID (e.g. com.apple.Safari). If set, captures that app\'s frontmost window. If omitted, captures the entire screen.',
        },
        outPath: {
          type: 'string',
          description: 'Optional absolute path for the PNG. Defaults to ~/Library/Caches/tinky-vision-mcp/shot-<ts>.png',
        },
      },
    },
  },
  {
    name: 'os_list_apps',
    description: 'List all running .app processes with their bundle IDs and PIDs. Use this to find the bundle ID of the app you want to control.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'os_find_window',
    description: 'Search visible windows by title or owner-app substring. Returns matches with windowID, title, owner app, PID, and bounds (x/y/w/h). Use to locate a specific document window across multiple open instances.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Substring to match (case-insensitive). Empty string returns all visible windows.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'os_click',
    description: 'Synthetic mouse click at SCREEN coordinates (x, y in pixels). REQUIRES Accessibility permission for the tinky-os helper binary. WRITE action — first call per target prompts the user for consent via macOS dialog. Use os_screenshot first to find coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'integer', description: 'Screen-relative X pixel (0 = left edge of primary display).' },
        y: { type: 'integer', description: 'Screen-relative Y pixel (0 = top edge of primary display).' },
        double: { type: 'boolean', description: 'If true, performs a double-click.' },
        target: {
          type: 'string',
          description: 'Required label for the consent gate (e.g. "Safari" or "Photoshop"). The user sees this in the approval dialog.',
        },
        description: {
          type: 'string',
          description: 'Required short human-readable summary of what this click does (e.g. "click the Play button on Steve\'s World"). Shown in the consent dialog.',
        },
      },
      required: ['x', 'y', 'target', 'description'],
    },
  },
  {
    name: 'os_type',
    description: 'Type a string of text at the currently-focused field. REQUIRES Accessibility permission. WRITE action — first call per target prompts the user for consent. Click into the target field first via os_click.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type. Supports unicode + emoji.' },
        target: { type: 'string', description: 'Required consent label.' },
        description: { type: 'string', description: 'Required short summary of what is being typed where.' },
      },
      required: ['text', 'target', 'description'],
    },
  },
  {
    name: 'os_key',
    description: 'Press a single key with optional modifiers. REQUIRES Accessibility permission. WRITE action — first call per target prompts for consent. Use for keyboard shortcuts (Cmd+S, Cmd+W, Return, Escape, arrow keys, F1-F12).',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Key name. Known: return, enter, tab, space, escape, delete, backspace, left, right, up, down, home, end, pageup, pagedown, f1-f12. Single letter (a-z) or digit (0-9) also accepted.',
        },
        cmd:   { type: 'boolean', description: 'Hold Cmd.' },
        shift: { type: 'boolean', description: 'Hold Shift.' },
        opt:   { type: 'boolean', description: 'Hold Option.' },
        ctrl:  { type: 'boolean', description: 'Hold Control.' },
        target: { type: 'string', description: 'Required consent label.' },
        description: { type: 'string', description: 'Required short summary.' },
      },
      required: ['key', 'target', 'description'],
    },
  },
  {
    name: 'os_ax_check',
    description: 'Check whether the tinky-os helper has Accessibility permission. Returns { accessibility: true|false }. Call this first if click/type/key are failing — without Accessibility, they silently no-op at the OS level.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'os_focused_window',
    description: 'Report the currently frontmost app and its key window. Returns { focused: { bundleID, name, pid, window: { windowID, title, bounds } } } or null. Use this to verify which app a click will land in BEFORE calling os_click — also used internally by the deny-list to block writes against password managers / Keychain / SecurityAgent.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'vision_find_text',
    description: 'Run on-device OCR over the current screen (or a provided PNG) and return text matches with bounding boxes. Returns `image_px` (pixel coords inside the image) and `screen_pt` (point coords for os_click, null on multi-monitor). Use this to LOCATE clickable text like "Play", "Sign in", "OK" without guessing pixel coords. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional case-insensitive substring filter. Omit to get all detected text on screen.',
        },
        inPath: {
          type: 'string',
          description: 'Optional path to an existing PNG to OCR instead of capturing the screen. Useful for re-analyzing a previous os_screenshot.',
        },
      },
    },
  },
];

// ────────────────────────── server ──────────────────────────

const server = new Server(
  {
    name: 'tinky-vision-mcp',
    version: '0.1.0',
  },
  {
    capabilities: { tools: {} },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const startedAt = Date.now();
  try {
    let result;
    switch (name) {
      case 'os_screenshot': {
        const argv = [];
        if (args.bundleId) argv.push('--app', args.bundleId);
        if (args.outPath)  argv.push('--out', args.outPath);
        result = callHelper('screenshot', argv);
        break;
      }
      case 'os_list_apps':
        result = callHelper('apps');
        break;
      case 'os_find_window':
        result = callHelper('find-window', ['--query', args.query ?? '']);
        break;
      case 'os_click': {
        guardedWrite('os_click', args.target,
          `os_click(x=${args.x}, y=${args.y}${args.double ? ', double' : ''}): ${args.description}`);
        const argv = ['--x', String(args.x), '--y', String(args.y)];
        if (args.double) argv.push('--double');
        result = callHelper('click', argv);
        break;
      }
      case 'os_type': {
        guardedWrite('os_type', args.target,
          `os_type(${String(args.text || '').length} chars): ${args.description}`);
        result = callHelper('type', ['--text', String(args.text)]);
        break;
      }
      case 'os_key': {
        const mods = ['cmd','shift','opt','ctrl'].filter(m => args[m]).join('+');
        guardedWrite('os_key', args.target,
          `os_key(${mods ? mods + '+' : ''}${args.key}): ${args.description}`);
        const argv = ['--key', String(args.key)];
        for (const m of ['cmd','shift','opt','ctrl']) if (args[m]) argv.push(`--${m}`);
        result = callHelper('key', argv);
        break;
      }
      case 'os_ax_check':
        // The helper exits 1 when permission is missing — callHelper
        // throws in that case. Catch + return the JSON instead so the
        // tool always succeeds and the AI can read the answer.
        try { result = callHelper('ax-check'); }
        catch (e) { result = { ok: true, accessibility: false }; }
        break;
      case 'os_focused_window':
        result = callHelper('focused-window');
        break;
      case 'vision_find_text': {
        const argv = [];
        if (args.query)  argv.push('--query', String(args.query));
        if (args.inPath) argv.push('--in', String(args.inPath));
        result = callHelper('find-text', argv);
        break;
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    audit({ tool: name, args, ok: true, ms: Date.now() - startedAt });
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  } catch (err) {
    audit({ tool: name, args, ok: false, error: err.message, ms: Date.now() - startedAt });
    return {
      isError: true,
      content: [{ type: 'text', text: `Error: ${err.message}` }],
    };
  }
});

// ────────────────────────── start ──────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[tinky-vision-mcp] ready · helper=${HELPER_BIN} · log=${LOG_FILE}` +
  (READ_ONLY ? ' · READ-ONLY' : '')
);
