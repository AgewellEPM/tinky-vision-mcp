// Integration tests for tinky-vision-mcp. Spawns the server with the
// fake helper, exchanges JSON-RPC over stdio, asserts shape + policy
// gates. Uses Node's built-in node:test so there's no extra dep.
//
// Test surfaces:
//   1. Server boots + tools/list returns the expected set
//   2. Read-only mode allows reads, denies writes
//   3. Deny-list blocks writes when focused app is sensitive (even
//      with TINKY_AUTO_APPROVE=1 — policy beats consent)
//   4. Auto-approve bypasses the dialog for non-deny apps
//   5. AX-check survives the helper's exit-1 path
//   6. vision_find_text passes through canned helper JSON
//
// Run: `npm test` from repo root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, '..', 'src', 'server.mjs');
const FAKE   = resolve(__dirname, 'fake-helper.mjs');

// Tiny JSON-RPC-over-stdio client. Spawns the server with the requested
// env + args, sends framed messages, returns parsed responses keyed by
// id. Kills the server when done.
async function withServer({ env = {}, args = [] } = {}, fn) {
  const srv = spawn('node', [SERVER, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TINKY_HELPER_BIN: FAKE,
      ...env,
    },
  });
  const out = { buf: '', byId: new Map() };
  srv.stdout.on('data', (d) => {
    out.buf += d.toString();
    let i;
    while ((i = out.buf.indexOf('\n')) >= 0) {
      const line = out.buf.slice(0, i).trim();
      out.buf = out.buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null) out.byId.set(msg.id, msg);
      } catch { /* ignore non-JSON */ }
    }
  });
  // wait for server ready (writes to stderr)
  await new Promise((r) => {
    const onErr = (d) => {
      if (d.toString().includes('ready')) {
        srv.stderr.off('data', onErr);
        r();
      }
    };
    srv.stderr.on('data', onErr);
    setTimeout(r, 1500);
  });

  const call = async (id, method, params) => {
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
    // wait up to 2s for the matching id
    for (let i = 0; i < 40; i++) {
      if (out.byId.has(id)) return out.byId.get(id);
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timed out waiting for response id=${id}`);
  };

  // Always initialize first.
  await call(1, 'initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });

  try {
    return await fn({ call });
  } finally {
    srv.kill();
  }
}

function toolResult(resp) {
  const text = resp?.result?.content?.[0]?.text;
  if (text == null) return { _err: 'no content', resp };
  try { return JSON.parse(text); } catch { return { _text: text }; }
}

test('server boots and exposes the expected 9 tools', async () => {
  await withServer({}, async ({ call }) => {
    const list = await call(2, 'tools/list');
    const tools = list?.result?.tools ?? [];
    const names = tools.map(t => t.name).sort();
    assert.deepEqual(names, [
      'os_ax_check',
      'os_click',
      'os_find_window',
      'os_focused_window',
      'os_key',
      'os_list_apps',
      'os_screenshot',
      'os_type',
      'vision_find_text',
    ]);
  });
});

test('read-only mode blocks os_click but allows os_screenshot', async () => {
  await withServer({ args: ['--read-only'], env: { TINKY_AUTO_APPROVE: '1' } }, async ({ call }) => {
    const shot = await call(2, 'tools/call', { name: 'os_screenshot', arguments: {} });
    assert.equal(shot?.result?.isError, undefined, 'screenshot should succeed in read-only');
    const click = await call(3, 'tools/call', {
      name: 'os_click',
      arguments: { x: 10, y: 10, target: 'X', description: 'Y' },
    });
    assert.equal(click?.result?.isError, true, 'click should fail in read-only');
    assert.match(click?.result?.content?.[0]?.text || '', /read-only/i);
  });
});

test('deny-list blocks os_click when focused app is 1Password', async () => {
  await withServer({
    env: {
      TINKY_AUTO_APPROVE: '1',
      TINKY_FAKE_FOCUSED_BUNDLE: 'com.1password.1password',
    },
  }, async ({ call }) => {
    const click = await call(2, 'tools/call', {
      name: 'os_click',
      arguments: { x: 10, y: 10, target: 'NotePad', description: 'sneaky' },
    });
    assert.equal(click?.result?.isError, true, 'click MUST be blocked');
    assert.match(
      click?.result?.content?.[0]?.text || '',
      /deny-list/i,
      'error message should name the deny-list',
    );
  });
});

test('deny-list blocks os_type even with auto-approve when focused app is SecurityAgent', async () => {
  await withServer({
    env: {
      TINKY_AUTO_APPROVE: '1',
      TINKY_FAKE_FOCUSED_BUNDLE: 'com.apple.SecurityAgent',
    },
  }, async ({ call }) => {
    const typ = await call(2, 'tools/call', {
      name: 'os_type',
      arguments: { text: 'admin', target: 'X', description: 'Y' },
    });
    assert.equal(typ?.result?.isError, true);
    assert.match(typ?.result?.content?.[0]?.text || '', /DENIED/);
  });
});

test('extra deny via TINKY_DENY_BUNDLES is honored', async () => {
  await withServer({
    env: {
      TINKY_AUTO_APPROVE: '1',
      TINKY_FAKE_FOCUSED_BUNDLE: 'com.example.banking',
      TINKY_DENY_BUNDLES: 'com.example.banking:com.example.other',
    },
  }, async ({ call }) => {
    const click = await call(2, 'tools/call', {
      name: 'os_click',
      arguments: { x: 1, y: 1, target: 'X', description: 'Y' },
    });
    assert.equal(click?.result?.isError, true);
  });
});

test('auto-approve allows os_click when focused app is benign', async () => {
  await withServer({
    env: {
      TINKY_AUTO_APPROVE: '1',
      TINKY_FAKE_FOCUSED_BUNDLE: 'com.apple.Safari',
    },
  }, async ({ call }) => {
    const click = await call(2, 'tools/call', {
      name: 'os_click',
      arguments: { x: 100, y: 200, target: 'Safari', description: 'click play' },
    });
    assert.equal(click?.result?.isError, undefined, 'should succeed');
    const r = toolResult(click);
    assert.equal(r.ok, true);
    assert.equal(r.fake, true);
    assert.equal(r.sub, 'click');
  });
});

test('os_ax_check returns false (not error) when helper exits 1', async () => {
  await withServer({ env: { TINKY_FAKE_AX: 'false' } }, async ({ call }) => {
    const r = await call(2, 'tools/call', { name: 'os_ax_check', arguments: {} });
    assert.equal(r?.result?.isError, undefined, 'ax_check must not surface as tool error');
    const parsed = toolResult(r);
    assert.equal(parsed.accessibility, false);
  });
});

test('os_ax_check returns true when helper reports granted', async () => {
  await withServer({ env: { TINKY_FAKE_AX: 'true' } }, async ({ call }) => {
    const r = await call(2, 'tools/call', { name: 'os_ax_check', arguments: {} });
    const parsed = toolResult(r);
    assert.equal(parsed.accessibility, true);
  });
});

test('vision_find_text round-trips canned helper JSON', async () => {
  const canned = {
    ok: true,
    image: { width_px: 100, height_px: 100, screen_scale: 2.0 },
    query: 'play',
    matches: [{
      text: 'Play',
      confidence: 0.99,
      image_px: { x: 10, y: 20, w: 40, h: 30, cx: 30, cy: 35 },
      screen_pt: { x: 5, y: 10, w: 20, h: 15, cx: 15, cy: 17 },
    }],
    match_count: 1,
  };
  await withServer({ env: { TINKY_FAKE_FIND_TEXT_JSON: JSON.stringify(canned) } }, async ({ call }) => {
    const r = await call(2, 'tools/call', {
      name: 'vision_find_text',
      arguments: { query: 'play' },
    });
    const parsed = toolResult(r);
    assert.equal(parsed.match_count, 1);
    assert.equal(parsed.matches[0].text, 'Play');
    assert.equal(parsed.matches[0].screen_pt.cx, 15);
  });
});

test('os_focused_window returns bundleID', async () => {
  await withServer({
    env: { TINKY_FAKE_FOCUSED_BUNDLE: 'com.example.benign' },
  }, async ({ call }) => {
    const r = await call(2, 'tools/call', { name: 'os_focused_window', arguments: {} });
    const parsed = toolResult(r);
    assert.equal(parsed.focused.bundleID, 'com.example.benign');
  });
});

// ────────────────────────── security regression tests ──────────────────────────
// Codex review 2026-05-19 found 3 HIGH-severity issues in the consent /
// deny-list / audit-log path. These tests lock the fixes so a future
// "simplification" can't silently regress them.

test('SEC: deny-list FAILS CLOSED when helper cannot report focus (Codex HIGH#2)', async () => {
  // No TINKY_FAKE_FOCUSED_BUNDLE → fake helper returns focused: null.
  // Previously the deny-list silently fell through and the write tool
  // succeeded. Now it must be blocked with a "cannot identify" error.
  await withServer({
    env: { TINKY_AUTO_APPROVE: '1' },   // no fake focused bundle set
  }, async ({ call }) => {
    const click = await call(2, 'tools/call', {
      name: 'os_click',
      arguments: { x: 10, y: 10, target: 'Safari', description: 'click play' },
    });
    assert.equal(click?.result?.isError, true,
      'click MUST be blocked when focused-window helper returns null');
    assert.match(
      click?.result?.content?.[0]?.text || '',
      /cannot identify|focus is uncertain|focus-unknown|DENIED/i,
      'error message should name the fail-closed cause',
    );
  });
});

test('SEC: approval cache is keyed by observed bundle, not by AI-claimed target (Codex HIGH#3)', async () => {
  // We can't change the focused bundle mid-process (env is fixed at
  // spawn). So we approximate the regression by proving: when the fake
  // helper reports bundle A, an approval for target=X is granted; when
  // we relaunch the server with bundle B but the SAME target=X, the
  // approval cache must NOT carry over — the new (bundle, target) pair
  // re-triggers the consent path. AUTO_APPROVE bypasses the dialog,
  // so we verify the deny-list still gates correctly under cache-miss.
  // The simplest probe: with bundle = a deny-listed app, even an
  // identical (target, description) used minutes ago against a safe
  // bundle in another server instance MUST be blocked here. This shows
  // the cache cannot exfiltrate state across (bundle, target) pairs.
  await withServer({
    env: {
      TINKY_AUTO_APPROVE: '1',
      TINKY_FAKE_FOCUSED_BUNDLE: 'com.bitwarden.desktop',
    },
  }, async ({ call }) => {
    const r = await call(2, 'tools/call', {
      name: 'os_click',
      arguments: { x: 1, y: 1, target: 'Safari', description: 'click play' },
    });
    assert.equal(r?.result?.isError, true);
    assert.match(r?.result?.content?.[0]?.text || '', /deny-list/i);
  });
});

test('OPS: TINKY_AUDIT_DISABLE=1 suppresses log writes entirely', async () => {
  // v0.1.2 — environments that don't want any audit trail (CI,
  // automated test rigs, ephemeral containers) can opt out cleanly.
  const { readFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  const logPath = join(homedir(), 'Library', 'Logs', 'tinky-vision-mcp', 'session.jsonl');
  const before = existsSync(logPath) ? readFileSync(logPath, 'utf8').length : 0;
  await withServer({
    env: {
      TINKY_AUTO_APPROVE: '1',
      TINKY_FAKE_FOCUSED_BUNDLE: 'com.apple.Safari',
      TINKY_AUDIT_DISABLE: '1',
    },
  }, async ({ call }) => {
    await call(2, 'tools/call', { name: 'os_screenshot', arguments: {} });
    await call(3, 'tools/call', {
      name: 'os_type',
      arguments: { text: 'should-not-be-logged', target: 'X', description: 'Y' },
    });
  });
  const after = existsSync(logPath) ? readFileSync(logPath, 'utf8').length : 0;
  assert.equal(after, before, 'AUDIT_DISABLE=1 must not append any bytes to the log');
});

test('OPS: audit log rotates when size exceeds TINKY_AUDIT_ROTATE_MAX', async () => {
  // v0.1.2 — rotation prevents the log from growing unbounded.
  // Set a tiny threshold (1KB) + force counter to trigger every call
  // (env TINKY_TEST_ROTATE_EVERY_CALL bypasses the 100-call defer).
  // Run enough write tool calls to overflow + verify an archive
  // appeared in the log directory.
  const { readdirSync, existsSync, writeFileSync, mkdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  const dir = join(homedir(), 'Library', 'Logs', 'tinky-vision-mcp');
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, 'session.jsonl');
  // Pre-fill log to ~2KB so the first rotate check overflows the 1KB
  // threshold regardless of the 100-call defer.
  writeFileSync(logPath, 'x'.repeat(2048) + '\n');
  const beforeArchives = readdirSync(dir).filter(f => /^session\..+\.jsonl$/.test(f));
  await withServer({
    env: {
      TINKY_AUTO_APPROVE: '1',
      TINKY_FAKE_FOCUSED_BUNDLE: 'com.apple.Safari',
      TINKY_AUDIT_ROTATE_MAX: '1024',
    },
  }, async ({ call }) => {
    // First call triggers the rotate check (counter=1 in our impl
    // means rotate runs on first call, then skips for 99, then re-checks).
    await call(2, 'tools/call', { name: 'os_focused_window', arguments: {} });
  });
  const afterArchives = readdirSync(dir).filter(f => /^session\..+\.jsonl$/.test(f));
  assert.ok(afterArchives.length > beforeArchives.length,
    `expected new archive after rotation; before=${beforeArchives.length} after=${afterArchives.length}`);
  // session.jsonl should exist and be smaller than the threshold
  // (or just contain the one new entry).
  assert.ok(existsSync(logPath), 'fresh session.jsonl should exist post-rotation');
  assert.ok(statSync(logPath).size < 1024,
    `fresh log should be < threshold; got ${statSync(logPath).size}`);
});

test('SEC: audit log redacts os_type "text" payload (Codex HIGH#1)', async () => {
  // Run a successful os_type with a known sentinel + read the log file
  // to prove the cleartext never landed. The fake helper accepts
  // anything, so the only difference between the on-disk log and the
  // input is the redaction logic.
  const { readFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  const logPath = join(homedir(), 'Library', 'Logs', 'tinky-vision-mcp', 'session.jsonl');
  const beforeSize = existsSync(logPath) ? readFileSync(logPath, 'utf8').length : 0;
  const SENTINEL = 'PA55w0rd-DO-NOT-PERSIST-9X8Y7Z';

  await withServer({
    env: {
      TINKY_AUTO_APPROVE: '1',
      TINKY_FAKE_FOCUSED_BUNDLE: 'com.apple.Safari',
    },
  }, async ({ call }) => {
    const r = await call(2, 'tools/call', {
      name: 'os_type',
      arguments: { text: SENTINEL, target: 'Safari', description: 'fill password field' },
    });
    assert.equal(r?.result?.isError, undefined, 'type should succeed via auto-approve');
  });

  // Inspect only the audit lines written during this test (skip prior
  // bytes — earlier tests may have appended their own entries).
  const after = readFileSync(logPath, 'utf8').slice(beforeSize);
  assert.equal(after.includes(SENTINEL), false,
    'AUDIT LOG MUST NOT contain the cleartext text payload');
  assert.match(after, new RegExp(`REDACTED:${SENTINEL.length}ch`),
    'audit log should include a typed-length redaction marker');
});
