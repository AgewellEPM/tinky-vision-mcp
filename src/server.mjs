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
const HELPER_BIN = resolve(__dirname, '..', 'bin', 'tinky-os');
const LOG_DIR = join(homedir(), 'Library', 'Logs', 'tinky-vision-mcp');
const LOG_FILE = join(LOG_DIR, 'session.jsonl');
const READ_ONLY = process.argv.includes('--read-only');

if (!existsSync(HELPER_BIN)) {
  console.error(
    `[tinky-vision-mcp] FATAL: tinky-os helper binary not found at ${HELPER_BIN}.\n` +
    `Run \`npm run build:helper\` from the repo root, or grab the prebuilt binary.`
  );
  process.exit(2);
}

mkdirSync(LOG_DIR, { recursive: true });

// ────────────────────────── audit log ──────────────────────────

function audit(entry) {
  const line = JSON.stringify({ ts: Date.now(), ...entry }) + '\n';
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

/// In-memory per-session allow list of target apps the user has
/// already approved for write actions. Cleared on server restart so
/// every new Claude conversation re-prompts.
const approvedTargets = new Set();

/// Ask the user via /usr/bin/osascript for permission to perform a
/// write action against `target`. Returns true on yes, false on no.
/// `description` is a short human-readable summary of what the AI
/// wants to do, shown verbatim in the dialog.
function requestConsent(target, description) {
  if (READ_ONLY) return false;
  if (approvedTargets.has(target)) return true;
  const title = 'Tinky Vision MCP — Action approval';
  const detail = `Claude wants to perform an OS-level action:\n\n${description}\n\nTarget: ${target}\n\nApprove this and future actions against this target for the current session?`;
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
      approvedTargets.add(target);
      return true;
    }
    if (out === 'Approve once') return true;
    return false;
  } catch {
    return false;
  }
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
        if (READ_ONLY) throw new Error('Write tools disabled (--read-only).');
        if (!requestConsent(args.target, `os_click(x=${args.x}, y=${args.y}${args.double ? ', double' : ''}): ${args.description}`)) {
          throw new Error('User denied consent for os_click.');
        }
        const argv = ['--x', String(args.x), '--y', String(args.y)];
        if (args.double) argv.push('--double');
        result = callHelper('click', argv);
        break;
      }
      case 'os_type': {
        if (READ_ONLY) throw new Error('Write tools disabled (--read-only).');
        if (!requestConsent(args.target, `os_type(${args.text.length} chars): ${args.description}`)) {
          throw new Error('User denied consent for os_type.');
        }
        result = callHelper('type', ['--text', String(args.text)]);
        break;
      }
      case 'os_key': {
        if (READ_ONLY) throw new Error('Write tools disabled (--read-only).');
        const mods = ['cmd','shift','opt','ctrl'].filter(m => args[m]).join('+');
        if (!requestConsent(args.target, `os_key(${mods ? mods + '+' : ''}${args.key}): ${args.description}`)) {
          throw new Error('User denied consent for os_key.');
        }
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
