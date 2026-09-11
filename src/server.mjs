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
// Tools exposed (16 total, all macOS-host-only):
//   read-only:
//     portal_state         portal source/session/focus/input/health heartbeat
//     portal_snapshot      verified composed/full TinkyStream image
//     os_screenshot        capture screen or app window
//     os_list_apps         enumerate running regular .app processes
//     os_find_window       search visible windows by title/owner
//     os_focused_window    report the frontmost app + key window
//     vision_find_text     on-device OCR (Vision framework) → text + coords
//     os_ax_check          report Accessibility permission state
//   write (gated):
//     os_click             mouse click at screen coords
//     os_type              type text at focused field
//     os_key               press a key with optional modifiers
//
// Security gate (every WRITE tool, in order):
//   1. Read-only check       — `--read-only` blocks all writes
//   2. Sensitive-app deny-list — hard policy block when 1Password /
//      Bitwarden / LastPass / Dashlane / Keychain / SecurityAgent /
//      Touch-ID / Terminal / iTerm / Screen Sharing / System Settings
//      is focused. FAILS CLOSED: if focused-window helper can't
//      identify focus (helper crash, no app frontmost), write is
//      blocked. Cannot be opted past in-session. Extend via
//      TINKY_DENY_BUNDLES env (colon-separated).
//   3. Consent dialog — keyed on (observed bundle × AI-claimed
//      target). "Approve session" remembers ONLY that exact pair;
//      a different bundle re-prompts. AUTO_APPROVE env bypasses
//      the dialog (testing only, NEVER on by default).
//
// Audit log at ~/Library/Logs/tinky-vision-mcp/session.jsonl. os_type
// `text` payloads are redacted to `[REDACTED:Nch]` before write —
// passwords typed through the helper never land on disk in cleartext.
// SECRET_ARG_KEYS extends the redaction set for future tools.
//
// v0.1.2: size-based log rotation. When session.jsonl exceeds
// TINKY_AUDIT_ROTATE_MAX (default 5MB), it is renamed
// session.<iso-ts>.jsonl and a fresh session.jsonl begins. Keeps the
// last TINKY_AUDIT_KEEP_FILES archives (default 5), unlinks older.
// TINKY_AUDIT_DISABLE=1 suppresses logging entirely (CI/ephemeral
// runs). Rotation runs at most every 100 appends — one stat() per
// ~100 tool calls is cheap, and off-by-N around the threshold is
// harmless.
//
// LABEL: v0.1.7 — PILOT-READY for vision, session-bound remote control,
// and authenticated remote file transfer. Still needs signed distribution +
// real-app hardware smoke before PRODUCTION-READY.

import { spawn, execFileSync } from 'node:child_process';
import {
  mkdirSync, appendFileSync, existsSync,
  statSync, renameSync, readdirSync, unlinkSync,
  lstatSync, readFileSync, writeFileSync, chmodSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { ScopedAXBridge, SCOPED_AX_TOOLS, SCOPED_AX_OPERATIONS,
  redactScopedAXAuditArgs } from './scoped-ax.mjs';
import { scopedAXHelperPath, validateScopedAXHelper } from './scoped-ax-helper.mjs';

import { withToolMetadata } from './tool-metadata.mjs';

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
  (existsSync(resolve(__dirname, '..', 'bin', 'tinky-os-ax'))
    ? resolve(__dirname, '..', 'bin', 'tinky-os-ax')
    : resolve(__dirname, '..', 'bin', 'tinky-os'));
const DEFAULT_LOG_FILE = join(
  homedir(), 'Library', 'Logs', 'tinky-vision-mcp', 'session.jsonl',
);
// Tests and isolated operators can route one server process to its own log.
// The default remains the established user-visible location.
const LOG_FILE = resolve(process.env.TINKY_AUDIT_PATH || DEFAULT_LOG_FILE);
const LOG_DIR = dirname(LOG_FILE);
const READ_ONLY = process.argv.includes('--read-only') || process.env.TINKY_READ_ONLY === 'true';
const PORTAL_STREAM_DIR = resolve(process.env.TINKY_STREAM_DIR || join(
  homedir(), '.kist', 'runs', 'desktop-vision-console', 'stream',
));

const PORTAL_FILES = Object.freeze({
  handoff: 'portal-handoff.json',
  state: 'portal-state.json',
  composedRecord: 'composed-frame.json',
  composed: 'composed-latest.jpg',
  full: 'latest.jpg',
});
const PORTAL_CONTROL_DIR = join(PORTAL_STREAM_DIR, 'portal-control');
const PORTAL_CONTROL_BINDING = join(PORTAL_CONTROL_DIR, 'binding.json');
const PORTAL_CONTROL_TOKEN = join(PORTAL_CONTROL_DIR, '.session-token');
const PORTAL_CONTROL_REQUESTS = join(PORTAL_CONTROL_DIR, 'requests');
const PORTAL_CONTROL_RESPONSES = join(PORTAL_CONTROL_DIR, 'responses');
const PORTAL_CONTROLLER_ID = randomUUID();
// The native portal host republishes this binding every 75ms. A five-second
// ceiling tolerates scheduling pressure while ensuring an old owner file can
// never be mistaken for a currently reachable physical Mac.
const PORTAL_CONTROL_MAX_AGE_MS = 5_000;

function readBoundedRegularFile(path, maximumBytes) {
  let info;
  try { info = lstatSync(path); }
  catch { throw new Error(`Portal vision file is unavailable: ${path}`); }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Portal vision path is not a regular file: ${path}`);
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error(`Portal vision file is not owned by this user: ${path}`);
  }
  if (info.size <= 0 || info.size > maximumBytes) {
    throw new Error(`Portal vision file has invalid size ${info.size}: ${path}`);
  }
  return { data: readFileSync(path), info };
}

function readPortalJSON(name, maximumBytes = 1024 * 1024) {
  const path = join(PORTAL_STREAM_DIR, name);
  const { data, info } = readBoundedRegularFile(path, maximumBytes);
  try { return { value: JSON.parse(data.toString('utf8')), path, info }; }
  catch { throw new Error(`Portal vision JSON is malformed: ${path}`); }
}

function portalStateSnapshot() {
  let handoff = null;
  let handoffObservation = null;
  const handoffPath = join(PORTAL_STREAM_DIR, PORTAL_FILES.handoff);
  if (existsSync(handoffPath)) {
    const handoffFile = readPortalJSON(PORTAL_FILES.handoff, 256 * 1024);
    if (handoffFile.value?.schemaVersion !== 1) {
      throw new Error(
        `Unsupported portal-handoff schema: ${handoffFile.value?.schemaVersion ?? 'missing'}`,
      );
    }
    handoff = handoffFile.value;
    handoffObservation = {
      path: handoffFile.path,
      fileAgeMs: Math.max(0, Date.now() - handoffFile.info.mtimeMs),
    };
  }

  let stateFile;
  try {
    stateFile = readPortalJSON(PORTAL_FILES.state);
  } catch (error) {
    if (!handoff) throw error;
    return {
      schemaVersion: 1,
      session: null,
      health: null,
      focus: null,
      input: null,
      vision: null,
      handoff,
      observation: {
        readAt: new Date().toISOString(),
        statePath: join(PORTAL_STREAM_DIR, PORTAL_FILES.state),
        stateUnavailable: error instanceof Error ? error.message : String(error),
        handoff: handoffObservation,
      },
    };
  }
  const state = stateFile.value;
  if (state?.schemaVersion !== 1) {
    throw new Error(`Unsupported portal-state schema: ${state?.schemaVersion ?? 'missing'}`);
  }
  const now = Date.now();
  const observedAt = Date.parse(state?.health?.observedAt || '');
  const lastFrameAt = Date.parse(state?.health?.lastFrameAt || '');
  const heartbeatAt = Date.parse(state?.vision?.heartbeatAt || '');
  const { portalLatestPath: _nonexistentPortalPath, ...reportedVision } = state?.vision || {};
  const availableLanes = [];
  if (existsSync(join(PORTAL_STREAM_DIR, PORTAL_FILES.composedRecord)) &&
      existsSync(join(PORTAL_STREAM_DIR, PORTAL_FILES.composed))) {
    availableLanes.push('composed');
  }
  if (existsSync(join(PORTAL_STREAM_DIR, PORTAL_FILES.full))) {
    availableLanes.push('full');
  }
  return {
    ...state,
    vision: state?.vision ? { ...reportedVision, availableLanes } : null,
    handoff,
    observation: {
      readAt: new Date(now).toISOString(),
      statePath: stateFile.path,
      stateFileAgeMs: Math.max(0, now - stateFile.info.mtimeMs),
      observedAgeMs: Number.isFinite(observedAt) ? Math.max(0, now - observedAt) : null,
      frameAgeMs: Number.isFinite(lastFrameAt) ? Math.max(0, now - lastFrameAt) : null,
      heartbeatAgeMs: Number.isFinite(heartbeatAt) ? Math.max(0, now - heartbeatAt) : null,
      handoff: handoffObservation,
    },
  };
}

function readVerifiedPortalLane(lane) {
  if (lane === 'full') {
    const path = join(PORTAL_STREAM_DIR, PORTAL_FILES.full);
    const { data, info } = readBoundedRegularFile(path, 64 * 1024 * 1024);
    return {
      data,
      path,
      sha256: createHash('sha256').update(data).digest('hex'),
      bytes: data.length,
      ageMs: Math.max(0, Date.now() - info.mtimeMs),
      record: null,
    };
  }
  let lastMismatch;
  for (let attempt = 0; attempt < 3; attempt++) {
    const recordFile = readPortalJSON(PORTAL_FILES.composedRecord);
    const imagePath = join(PORTAL_STREAM_DIR, PORTAL_FILES.composed);
    const { data, info } = readBoundedRegularFile(imagePath, 64 * 1024 * 1024);
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (recordFile.value?.jpegSHA256 === sha256 &&
        recordFile.value?.lane === lane &&
        recordFile.value?.schemaVersion === 1) {
      return {
        data,
        path: imagePath,
        sha256,
        bytes: data.length,
        ageMs: Math.max(0, Date.now() - info.mtimeMs),
        record: recordFile.value,
      };
    }
    lastMismatch = `Portal ${lane} frame does not match its atomic metadata record.`;
  }
  throw new Error(lastMismatch);
}

function readOwnerOnlyFile(path, maximumBytes) {
  const file = readBoundedRegularFile(path, maximumBytes);
  if ((file.info.mode & 0o077) !== 0) {
    throw new Error(`Portal control file is not owner-only: ${path}`);
  }
  return file;
}

function portalControlBinding() {
  const { data, info } = readOwnerOnlyFile(PORTAL_CONTROL_BINDING, 256 * 1024);
  let value;
  try { value = JSON.parse(data.toString('utf8')); }
  catch { throw new Error('Portal control binding is malformed.'); }
  if (value?.schemaVersion !== 1 || value?.sourceKind !== 'remoteMac') {
    throw new Error('The active portal is not a controllable remote Mac session.');
  }
  const now = Date.now();
  const rawFileAgeMs = now - info.mtimeMs;
  const declaredUpdatedAt = Number(value.updatedAtMilliseconds);
  const declaredAgeMs = now - declaredUpdatedAt;
  const hostPID = Number(value.hostProcessIdentifier);
  let hostProcessLive = false;
  if (Number.isSafeInteger(hostPID) && hostPID > 1) {
    try {
      process.kill(hostPID, 0);
      hostProcessLive = true;
    } catch (error) {
      // EPERM still proves that a process occupies the advertised PID. The
      // owner-private binding and tight freshness window remain mandatory.
      hostProcessLive = error?.code === 'EPERM';
    }
  }
  const fresh = rawFileAgeMs >= -1_000 &&
    rawFileAgeMs <= PORTAL_CONTROL_MAX_AGE_MS &&
    Number.isFinite(declaredUpdatedAt) &&
    declaredAgeMs >= -1_000 &&
    declaredAgeMs <= PORTAL_CONTROL_MAX_AGE_MS;
  const transportReady = typeof value.transportSessionID === 'string' &&
    value.transportSessionID.length > 0;
  const available = fresh && hostProcessLive && transportReady;
  const hostMessage = value.message;
  return {
    ...value,
    hostMessage,
    message: available
      ? hostMessage
      : 'Remote Mac control host is offline or stale; no control command can be sent.',
    observation: {
      readAt: new Date(now).toISOString(),
      ageMs: Math.max(0, rawFileAgeMs),
      declaredAgeMs: Number.isFinite(declaredAgeMs)
        ? Math.max(0, declaredAgeMs)
        : null,
      fresh,
      hostProcessLive,
      transportReady,
      available,
      controllerMatches: value.controllerID === PORTAL_CONTROLLER_ID,
    },
  };
}

function requireAvailablePortalControl(binding) {
  if (!binding?.observation?.available) {
    throw new Error(
      'The remote Mac control host is offline, stale, or lacks an authenticated transport session.',
    );
  }
  return binding;
}

function requireActivePortalControl() {
  const binding = requireAvailablePortalControl(portalControlBinding());
  if (!binding.active || binding.controllerID !== PORTAL_CONTROLLER_ID) {
    throw new Error(
      'Perslis control is not granted to this MCP process. Call portal_remote_begin first.',
    );
  }
  if (!binding.transportSessionID ||
      Number(binding.grantedUntilMilliseconds || 0) < Date.now()) {
    throw new Error('The Perslis control grant expired or has no live transport session.');
  }
  return binding;
}

function wait(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

async function sendPortalControlCommand(action, values = {}, timeoutMs = 30_000) {
  const binding = requireAvailablePortalControl(portalControlBinding());
  const token = readOwnerOnlyFile(PORTAL_CONTROL_TOKEN, 1024)
    .data.toString('utf8').trim();
  if (token.length < 64 || token.length > 256) {
    throw new Error('Portal control session token is invalid.');
  }
  for (const directory of [PORTAL_CONTROL_REQUESTS, PORTAL_CONTROL_RESPONSES]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  const commandID = randomUUID();
  const now = Date.now();
  const command = {
    schemaVersion: 1,
    commandID,
    controllerID: PORTAL_CONTROLLER_ID,
    token,
    sourceID: binding.sourceID,
    transportSessionID: binding.transportSessionID,
    issuedAtMilliseconds: now,
    expiresAtMilliseconds: now + Math.min(60_000, Math.max(5_000, timeoutMs)),
    action,
    ...values,
  };
  const requestPath = join(PORTAL_CONTROL_REQUESTS, `${commandID}.json`);
  const temporaryPath = join(PORTAL_CONTROL_REQUESTS, `.${commandID}.${process.pid}.tmp`);
  const responsePath = join(PORTAL_CONTROL_RESPONSES, `${commandID}.json`);
  writeFileSync(temporaryPath, JSON.stringify(command), { flag: 'wx', mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, requestPath);
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (existsSync(responsePath)) {
        const { data } = readOwnerOnlyFile(responsePath, 1024 * 1024);
        const response = JSON.parse(data.toString('utf8'));
        unlinkSync(responsePath);
        if (response.commandID !== commandID) {
          throw new Error('Portal control response ID does not match its command.');
        }
        if (!response.ok) throw new Error(response.message || 'Remote action failed.');
        return { ...response, binding: portalControlBinding() };
      }
      await wait(50);
    }
    throw new Error(`Portal control action ${action} timed out.`);
  } finally {
    try { if (existsSync(requestPath)) unlinkSync(requestPath); } catch { /* exact stale request */ }
  }
}

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
// Independent, lazy native lane. Its own visible consent cannot inherit the
// legacy AUTO_APPROVE switch, and restart never revives an old window handle.
let scopedAX = null;
function scopedAXBridge() {
  if (!scopedAX) {
    const root = resolve(__dirname, '..');
    const helper = scopedAXHelperPath(root);
    scopedAX = new ScopedAXBridge({ helperPath: validateScopedAXHelper(root, helper), readOnly: READ_ONLY,
      denyBundles: [...DENY_BUNDLES], beforeSpawn: () => validateScopedAXHelper(root, helper) });
  }
  return scopedAX;
}

// ─────────────────────── self-substrate protection ───────────────────────
// HARD block (un-bypassable by consent): refuse a WRITE whose payload is a
// self-restart of the Kist runtime this agent lives in. On 2026-07-09 an agent
// typed/approved `launchctl kickstart -k com.kist.desktop-vision-console`,
// restarting the service it ran inside; KeepAlive respawned it in a heavy-model
// reload loop and froze the machine.
//
// This checks only the CHEAP, hot-path signals: the text being typed and the
// caller's action label — NOT per-keystroke screen OCR (too heavy for every
// click/type; the console's circuit breaker is the deterministic backstop for
// the "press enter on a pre-shown command" case).
function substrateContentRefusal(...parts) {
  const text = parts.filter(Boolean).map(String).join(' ').toLowerCase();
  const reason =
    'DENIED: self-substrate protection — refusing to type/click a self-restart of the Kist runtime '
    + 'this agent lives in (launchctl on com.kist.* / kill of the desktop-vision-console / port 8765). '
    + 'This froze the machine on 2026-07-09. A human must do it from a terminal that is NOT this service.';
  if (text.includes('launchctl') && text.includes('com.kist.')) {
    const mutators = ['kickstart', 'bootout', 'unload', 'load', 'bootstrap',
                      'remove', 'disable', 'enable', 'stop', 'kill'];
    if (mutators.some(m => text.includes(m))) return reason;
  }
  const touchesConsole = text.includes('desktop-vision-console') || text.includes('com.kist.runtime');
  if (touchesConsole && (text.includes('pkill') || text.includes('killall') || text.includes('kill '))) return reason;
  if (text.includes('8765') && (text.includes('kill') || text.includes('fuser'))) return reason;
  return null;
}

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
  if (Object.hasOwn(SCOPED_AX_OPERATIONS, toolName)) {
    return redactScopedAXAuditArgs(SCOPED_AX_OPERATIONS[toolName], args);
  }
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

// v0.1.2 — size-based audit-log rotation. Without this the log grew
// unbounded forever (every tool call appends 100-300 bytes; a busy
// session can hit MBs). Rotate when LOG_FILE exceeds AUDIT_ROTATE_MAX
// bytes: rename session.jsonl → session.<ts>.jsonl, start fresh.
// Retain at most AUDIT_KEEP_FILES old archives; older ones unlink.
// Both knobs are env-tunable so power users can dial size vs retention.
const AUDIT_ROTATE_MAX = parseInt(process.env.TINKY_AUDIT_ROTATE_MAX, 10) || 5 * 1024 * 1024;
const AUDIT_KEEP_FILES = parseInt(process.env.TINKY_AUDIT_KEEP_FILES, 10) || 5;
const AUDIT_DISABLED   = process.env.TINKY_AUDIT_DISABLE === '1';

function rotateIfNeeded() {
  // Cheap check before EVERY append would be O(syscall). Defer to one
  // size check per N appends via a counter (real cost: one stat per ~100
  // tool calls). Off-by-one in either direction is harmless — we just
  // rotate slightly before or slightly after the threshold.
  rotateIfNeeded._counter = (rotateIfNeeded._counter || 0) + 1;
  if (rotateIfNeeded._counter < 100 && rotateIfNeeded._counter > 1) return;
  rotateIfNeeded._counter = 1;
  try {
    if (!existsSync(LOG_FILE)) return;
    const sz = statSync(LOG_FILE).size;
    if (sz < AUDIT_ROTATE_MAX) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archive = join(LOG_DIR, `session.${stamp}.jsonl`);
    renameSync(LOG_FILE, archive);
    // Trim retention: list session.*.jsonl, sort newest-first, drop
    // beyond AUDIT_KEEP_FILES.
    const archived = readdirSync(LOG_DIR)
      .filter(f => /^session\..+\.jsonl$/.test(f))
      .map(f => ({ f, p: join(LOG_DIR, f), m: statSync(join(LOG_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const { p } of archived.slice(AUDIT_KEEP_FILES)) {
      try { unlinkSync(p); } catch { /* silent */ }
    }
  } catch { /* silent — never let rotation break the write path */ }
}

function audit(entry) {
  if (AUDIT_DISABLED) return null;
  const safe = { ...entry };
  if (safe.args) safe.args = redactArgsForAudit(safe.tool, safe.args);
  const ts = Date.now();
  audit._counter = (audit._counter || 0) + 1;
  const eventId = `${ts}-${process.pid}-${audit._counter}`;
  const event = { ts, eventId, ...safe };
  const line = JSON.stringify(event) + '\n';
  try {
    rotateIfNeeded();
    appendFileSync(LOG_FILE, line);
    return { eventId, ts, logFile: LOG_FILE };
  } catch {
    // A missing audit receipt must be visible to callers. The tool action may
    // already have occurred, so return an explicit unavailable marker rather
    // than pretending there is durable evidence.
    return { eventId, ts, logFile: LOG_FILE, durable: false };
  }
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
  ...SCOPED_AX_TOOLS,
  {
    name: 'os_screenshot_image',
    description: 'Capture the screen or one app window and return an MCP image directly to the connected AI client. The image may be sent to the client model provider. Requires Screen Recording permission.',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: { bundleId: { type: 'string', description: 'Optional macOS application bundle identifier.' } } },
  },
  {
    name: 'portal_state',
    description:
      'Read the GhostBridge handoff phase plus active right-portal session identity, source kind, lifecycle/health, frame freshness, focus owner, cursor/keyboard capture, pressed input state, and TinkyStream paths. Read-only. Use this before reasoning about or controlling the portal.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'portal_snapshot',
    description:
      'See the active GhostBridge workspace through its verified composed left+right frame or TinkyStream full physical frame. The composed image is SHA-256 matched to atomic metadata and returned with session health/freshness. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        lane: {
          type: 'string',
          enum: ['composed', 'full'],
          description: 'composed = exact left+right compositor; full = TinkyStream physical capture. Defaults to composed.',
        },
      },
    },
  },
  {
    name: 'portal_remote_status',
    description:
      'Read the live Perslis-to-remote-Mac control binding: exact source, paired agent, authenticated transport session, grant owner/expiry, and whether this MCP process owns the active grant. Read-only.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'portal_remote_begin',
    description:
      'Ask the user for a visible, time-bounded grant allowing this MCP process to control the explicitly connected remote Mac in the GhostBridge right panel. The grant is bound to the paired agent and current authenticated transport session; reconnect revokes it.',
    inputSchema: {
      type: 'object',
      properties: {
        durationSeconds: { type: 'integer', minimum: 30, maximum: 900, description: 'Grant duration; defaults to 600 seconds.' },
        description: { type: 'string', description: 'Required plain-language explanation of what Perslis will do on the remote Mac.' },
      },
      required: ['description'],
    },
  },
  {
    name: 'portal_remote_control',
    description:
      'Control the explicitly connected remote Mac after portal_remote_begin. Coordinates are in the direct portal source frame returned by portal_snapshot, not full-screen coordinates. Supported actions: move, click, scroll, key, type.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['move', 'click', 'scroll', 'key', 'type'] },
        x: { type: 'number', description: 'Remote source-frame X for move/click.' },
        y: { type: 'number', description: 'Remote source-frame Y for move/click.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Click button; defaults to left.' },
        deltaX: { type: 'number', description: 'Horizontal pixel scroll delta.' },
        deltaY: { type: 'number', description: 'Vertical pixel scroll delta.' },
        keyCode: { type: 'integer', minimum: 0, maximum: 255, description: 'macOS virtual key code.' },
        text: { type: 'string', maxLength: 4096, description: 'Unicode text for the type action.' },
        modifiers: { type: 'array', items: { type: 'string', enum: ['capsLock', 'command', 'control', 'function', 'option', 'shift'] } },
        description: { type: 'string', description: 'Required plain-language summary for audit and user-visible intent.' },
      },
      required: ['action', 'description'],
    },
  },
  {
    name: 'portal_remote_files',
    description:
      'Move regular files through the authenticated remote-Mac session. send accepts absolute local paths and commits them into the remote owner-only transfer folder; receive accepts one safe filename from that folder and returns its verified local path.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['send', 'receive'] },
        paths: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Absolute local file paths for send.' },
        name: { type: 'string', description: 'Safe single filename for receive.' },
        contentType: { type: 'string', description: 'MIME type; defaults to application/octet-stream.' },
        description: { type: 'string', description: 'Required plain-language transfer intent.' },
      },
      required: ['mode', 'description'],
    },
  },
  {
    name: 'portal_remote_release',
    description:
      'Immediately release all remote mouse buttons and keys, return focus ownership to the left workspace, and revoke this MCP process control grant. This safety action remains available in read-only mode.',
    inputSchema: { type: 'object', properties: {} },
  },
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
    version: '0.2.0',
  },
  {
    capabilities: { tools: {} },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(withToolMetadata),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const startedAt = Date.now();
  try {
    let result;
    switch (name) {
      case 'os_ax_targets':
      case 'os_ax_snapshot':
      case 'os_ax_press':
      case 'os_ax_release':
        result = await scopedAXBridge().request(SCOPED_AX_OPERATIONS[name], args);
        break;
      case 'os_ax_enroll': {
        const refusal = substrateContentRefusal(args?.purpose);
        if (refusal) throw new Error(refusal);
        result = await scopedAXBridge().request('enroll', args);
        break;
      }
      case 'os_screenshot_image': {
        const argv = [];
        if (args.bundleId) argv.push('--app', args.bundleId);
        const frame = callHelper('screenshot', argv);
        if (!frame?.path || !frame.ok) throw new Error('Screenshot capture failed.');
        const { data } = readBoundedRegularFile(frame.path, 16 * 1024 * 1024);
        if (!data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
          throw new Error('Screenshot helper did not return a PNG.');
        }
        const auditReceipt = audit({ tool: name, args, ok: true, ms: Date.now() - startedAt });
        return { content: [
          { type: 'text', text: JSON.stringify({ ...frame, auditReceipt }) },
          { type: 'image', data: data.toString('base64'), mimeType: 'image/png' },
        ] };
      }
      case 'os_screenshot': {
        const argv = [];
        if (args.bundleId) argv.push('--app', args.bundleId);
        if (args.outPath)  argv.push('--out', args.outPath);
        result = callHelper('screenshot', argv);
        break;
      }
      case 'portal_state':
        result = portalStateSnapshot();
        break;
      case 'portal_snapshot': {
        const lane = args.lane || 'composed';
        if (!['composed', 'full'].includes(lane)) {
          throw new Error(`Invalid portal lane: ${lane}`);
        }
        const state = portalStateSnapshot();
        const frame = readVerifiedPortalLane(lane);
        const summary = {
          ok: true,
          lane,
          imagePath: frame.path,
          imageSHA256: frame.sha256,
          imageBytes: frame.bytes,
          imageAgeMs: frame.ageMs,
          frameRecord: frame.record,
          portal: state,
        };
        result = {
          _mcpContent: [
            { type: 'text', text: JSON.stringify(summary) },
            { type: 'image', data: frame.data.toString('base64'), mimeType: 'image/jpeg' },
          ],
          _auditSummary: summary,
        };
        break;
      }
      case 'portal_remote_status':
        result = portalControlBinding();
        break;
      case 'portal_remote_begin': {
        const binding = requireAvailablePortalControl(portalControlBinding());
        const description = String(args.description || '').trim();
        if (!description) {
          throw new Error('A plain-language remote-control description is required.');
        }
        const durationSeconds = args.durationSeconds ?? 600;
        if (!Number.isInteger(durationSeconds) ||
            durationSeconds < 30 || durationSeconds > 900) {
          throw new Error('durationSeconds must be an integer from 30 through 900.');
        }
        const remoteTarget =
          `GhostBridge remote Mac ${binding.displayName}` +
          (binding.remoteAgentID ? ` (${binding.remoteAgentID})` : '');
        guardedWrite(
          'portal_remote_begin',
          remoteTarget,
          `Grant Perslis control for ${durationSeconds} seconds: ${description}`,
        );
        result = await sendPortalControlCommand('begin', { durationSeconds });
        break;
      }
      case 'portal_remote_control': {
        requireActivePortalControl();
        const action = String(args.action || '');
        const description = String(args.description || '').trim();
        if (!description) throw new Error('A remote action description is required.');
        const refusal = substrateContentRefusal(args.text, description);
        if (refusal) throw new Error(refusal);

        const values = {};
        const finite = (value, label) => {
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new Error(`${label} must be a finite number.`);
          }
          return value;
        };
        if (args.modifiers != null) {
          if (!Array.isArray(args.modifiers) ||
              args.modifiers.some(value => ![
                'capsLock', 'command', 'control', 'function', 'option', 'shift',
              ].includes(value))) {
            throw new Error('modifiers contains an unsupported value.');
          }
          values.modifiers = [...new Set(args.modifiers)];
        }
        switch (action) {
          case 'move':
            values.x = finite(args.x, 'x');
            values.y = finite(args.y, 'y');
            break;
          case 'click':
            values.x = finite(args.x, 'x');
            values.y = finite(args.y, 'y');
            values.button = args.button || 'left';
            if (!['left', 'right', 'middle'].includes(values.button)) {
              throw new Error('button must be left, right, or middle.');
            }
            break;
          case 'scroll':
            values.deltaX = finite(args.deltaX ?? 0, 'deltaX');
            values.deltaY = finite(args.deltaY ?? 0, 'deltaY');
            if (values.deltaX === 0 && values.deltaY === 0) {
              throw new Error('scroll requires a non-zero deltaX or deltaY.');
            }
            break;
          case 'key':
            if (!Number.isInteger(args.keyCode) || args.keyCode < 0 || args.keyCode > 255) {
              throw new Error('keyCode must be an integer from 0 through 255.');
            }
            values.keyCode = args.keyCode;
            break;
          case 'type':
            if (typeof args.text !== 'string' || args.text.length === 0 || args.text.length > 4096) {
              throw new Error('text must contain 1 through 4096 characters.');
            }
            values.text = args.text;
            break;
          default:
            throw new Error(`Unsupported remote action: ${action || '<missing>'}.`);
        }
        result = await sendPortalControlCommand(action, values);
        break;
      }
      case 'portal_remote_files': {
        requireActivePortalControl();
        const mode = String(args.mode || '');
        const description = String(args.description || '').trim();
        if (!description) throw new Error('A file-transfer description is required.');
        if (mode === 'send') {
          if (!Array.isArray(args.paths) || args.paths.length === 0 ||
              args.paths.some(path => typeof path !== 'string' ||
                !path.startsWith('/') || path.includes('\0'))) {
            throw new Error('send requires one or more absolute local file paths.');
          }
          result = await sendPortalControlCommand(
            'sendFiles',
            { paths: args.paths },
            120_000,
          );
        } else if (mode === 'receive') {
          const name = args.name;
          if (typeof name !== 'string' || name.length === 0 || name.length > 255 ||
              name === '.' || name === '..' || name.includes('/') ||
              name.includes('\\') || name.includes('\0')) {
            throw new Error('receive requires one safe filename without path separators.');
          }
          const contentType = args.contentType || 'application/octet-stream';
          if (typeof contentType !== 'string' || contentType.length > 255) {
            throw new Error('contentType must be a short string.');
          }
          result = await sendPortalControlCommand(
            'receiveFile',
            { name, contentType },
            120_000,
          );
        } else {
          throw new Error('mode must be send or receive.');
        }
        break;
      }
      case 'portal_remote_release':
        result = await sendPortalControlCommand('release', {}, 10_000);
        break;
      case 'os_list_apps':
        result = callHelper('apps');
        break;
      case 'os_find_window':
        result = callHelper('find-window', ['--query', args.query ?? '']);
        break;
      case 'os_click': {
        { const sub = substrateContentRefusal(args.description, args.target); if (sub) throw new Error(sub); }
        guardedWrite('os_click', args.target,
          `os_click(x=${args.x}, y=${args.y}${args.double ? ', double' : ''}): ${args.description}`);
        const argv = ['--x', String(args.x), '--y', String(args.y)];
        if (args.double) argv.push('--double');
        result = callHelper('click', argv);
        break;
      }
      case 'os_type': {
        { const sub = substrateContentRefusal(args.text, args.description, args.target); if (sub) throw new Error(sub); }
        guardedWrite('os_type', args.target,
          `os_type(${String(args.text || '').length} chars): ${args.description}`);
        result = callHelper('type', ['--text', String(args.text)]);
        break;
      }
      case 'os_key': {
        { const sub = substrateContentRefusal(args.description, args.target); if (sub) throw new Error(sub); }
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
    const scopedObservation = Object.hasOwn(SCOPED_AX_OPERATIONS, name)
      ? { ok: result.disposition === 'observed', disposition: result.disposition,
        code: result.code, accepted: false } : { ok: true };
    const auditReceipt = audit({ tool: name, args, ...scopedObservation, ms: Date.now() - startedAt });
    if (result?._mcpContent) {
      const content = [...result._mcpContent];
      const summary = { ...result._auditSummary, auditReceipt };
      content[0] = { type: 'text', text: JSON.stringify(summary) };
      return { content };
    }
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      result = { ...result, auditReceipt };
    }
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
server.onclose = () => { void scopedAX?.close(); };
process.stdin.once('end', () => { void scopedAX?.close(); });
for (const event of ['SIGINT', 'SIGTERM']) {
  process.once(event, () => { void Promise.resolve(scopedAX?.close()).finally(() => process.exit(0)); });
}
process.once('exit', () => scopedAX?.closeNow());
await server.connect(transport);
console.error(
  `[tinky-vision-mcp] ready · helper=${HELPER_BIN} · log=${LOG_FILE}` +
  (READ_ONLY ? ' · READ-ONLY' : '')
);
