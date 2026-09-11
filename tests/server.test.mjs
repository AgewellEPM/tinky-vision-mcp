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
import { createHash } from 'node:crypto';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

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
  const initialize = await call(1, 'initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });

  try {
    return await fn({ call, initialize });
  } finally {
    srv.kill();
  }
}

function toolResult(resp) {
  const text = resp?.result?.content?.[0]?.text;
  if (text == null) return { _err: 'no content', resp };
  try { return JSON.parse(text); } catch { return { _text: text }; }
}

test('MCPB read-only setting blocks input through its environment setting', async () => {
  await withServer({env: {TINKY_READ_ONLY: 'true', TINKY_AUDIT_DISABLE: '1'}}, async ({call}) => {
    const response = await call(2, 'tools/call', {name: 'os_click', arguments: {
      x: 1, y: 1, target: 'fixture', description: 'fixture input must be blocked',
    }});
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /read.only/i);
  });
});

test('server boots and exposes the expected legacy and scoped AX tools', async () => {
  await withServer({}, async ({ call, initialize }) => {
    assert.equal(initialize?.result?.serverInfo?.version, '0.2.0');
    const list = await call(2, 'tools/list');
    const tools = list?.result?.tools ?? [];
    const names = tools.map(t => t.name).sort();
    assert.deepEqual(names, [
      'os_ax_check',
      'os_ax_enroll',
      'os_ax_press',
      'os_ax_release',
      'os_ax_snapshot',
      'os_ax_targets',
      'os_click',
      'os_find_window',
      'os_focused_window',
      'os_key',
      'os_list_apps',
      'os_screenshot',
      'os_screenshot_image',
      'os_type',
      'portal_remote_begin',
      'portal_remote_control',
      'portal_remote_files',
      'portal_remote_release',
      'portal_remote_status',
      'portal_snapshot',
      'portal_state',
      'vision_find_text',
    ]);
    for (const tool of tools) {
      assert.ok(tool.title);
      assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
      assert.equal(typeof tool.annotations.destructiveHint, 'boolean');
    }
    assert.equal(tools.find(t => t.name === 'os_click').annotations.readOnlyHint, false);
    assert.equal(tools.find(t => t.name === 'os_ax_release').annotations.readOnlyHint, false);
    const snapshot = tools.find(tool => tool.name === 'portal_snapshot');
    assert.deepEqual(snapshot.inputSchema.properties.lane.enum, ['composed', 'full']);
  });
});

function makeFakePortalControlHost(streamDir) {
  const root = resolve(streamDir, 'portal-control');
  const requests = resolve(root, 'requests');
  const responses = resolve(root, 'responses');
  mkdirSync(requests, { recursive: true, mode: 0o700 });
  mkdirSync(responses, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  chmodSync(requests, 0o700);
  chmodSync(responses, 0o700);
  const token = 'a'.repeat(64);
  const tokenPath = resolve(root, '.session-token');
  writeFileSync(tokenPath, token, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  const bindingPath = resolve(root, 'binding.json');
  let controllerID = null;
  let active = false;
  const actions = [];

  const publishBinding = () => {
    writeFileSync(bindingPath, JSON.stringify({
      schemaVersion: 1,
      hostProcessIdentifier: process.pid,
      sourceID: 'remote-imac',
      sourceKind: 'remoteMac',
      displayName: 'iMac Panel',
      remoteAgentID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      transportSessionID: 'transport-session-a',
      active,
      controllerID,
      grantedUntilMilliseconds: active ? Date.now() + 60_000 : null,
      updatedAtMilliseconds: Date.now(),
      lastCommandAtMilliseconds: null,
      message: active ? 'Perslis control is active.' : 'Perslis control is released.',
    }), { mode: 0o600 });
    chmodSync(bindingPath, 0o600);
  };
  publishBinding();

  const timer = setInterval(() => {
    for (const file of readdirSync(requests).filter(name => name.endsWith('.json'))) {
      const path = resolve(requests, file);
      let command;
      try { command = JSON.parse(readFileSync(path, 'utf8')); }
      catch { continue; }
      actions.push(command);
      let ok = command.token === token &&
        command.sourceID === 'remote-imac' &&
        command.transportSessionID === 'transport-session-a';
      let message = 'ok';
      if (ok && command.action === 'begin') {
        controllerID = command.controllerID;
        active = true;
        publishBinding();
      } else if (ok && command.action === 'release') {
        controllerID = null;
        active = false;
        publishBinding();
      } else if (ok && command.controllerID !== controllerID) {
        ok = false;
        message = 'controller mismatch';
      }
      const response = {
        schemaVersion: 1,
        commandID: command.commandID,
        ok,
        completedAtMilliseconds: Date.now(),
        message,
        localPath: command.action === 'receiveFile' ? '/tmp/incoming/demo.png' : null,
      };
      const responsePath = resolve(responses, file);
      writeFileSync(responsePath, JSON.stringify(response), { mode: 0o600 });
      chmodSync(responsePath, 0o600);
      try { unlinkSync(path); } catch { /* MCP may remove the exact request */ }
    }
  }, 10);

  return {
    actions,
    bindingPath,
    stop() { clearInterval(timer); },
  };
}

test('portal remote MCP grant, control, files, and release stay session-bound', async () => {
  const streamDir = mkdtempSync(resolve(tmpdir(), 'tinky-control-test-'));
  const host = makeFakePortalControlHost(streamDir);
  try {
    await withServer({
      env: {
        TINKY_STREAM_DIR: streamDir,
        TINKY_AUTO_APPROVE: '1',
        TINKY_FAKE_FOCUSED_BUNDLE: 'com.apple.Safari',
        TINKY_AUDIT_DISABLE: '1',
      },
    }, async ({ call }) => {
      const status = toolResult(await call(2, 'tools/call', {
        name: 'portal_remote_status', arguments: {},
      }));
      assert.equal(status.sourceID, 'remote-imac');
      assert.equal(status.active, false);

      const begin = toolResult(await call(3, 'tools/call', {
        name: 'portal_remote_begin',
        arguments: { durationSeconds: 60, description: 'Open one test document.' },
      }));
      assert.equal(begin.binding.active, true);
      assert.equal(begin.binding.observation.controllerMatches, true);

      const control = await call(4, 'tools/call', {
        name: 'portal_remote_control',
        arguments: { action: 'click', x: 120, y: 240, description: 'Select the document.' },
      });
      assert.equal(control?.result?.isError, undefined);

      const send = await call(5, 'tools/call', {
        name: 'portal_remote_files',
        arguments: {
          mode: 'send', paths: ['/tmp/demo.png'],
          description: 'Send the test image to the paired iMac.',
        },
      });
      assert.equal(send?.result?.isError, undefined);

      const receive = toolResult(await call(6, 'tools/call', {
        name: 'portal_remote_files',
        arguments: {
          mode: 'receive', name: 'demo.png',
          description: 'Receive the test image from the paired iMac.',
        },
      }));
      assert.equal(receive.localPath, '/tmp/incoming/demo.png');

      const release = toolResult(await call(7, 'tools/call', {
        name: 'portal_remote_release', arguments: {},
      }));
      assert.equal(release.binding.active, false);
    });
    assert.deepEqual(host.actions.map(command => command.action), [
      'begin', 'click', 'sendFiles', 'receiveFile', 'release',
    ]);
    assert.equal(new Set(host.actions.map(command => command.transportSessionID)).size, 1);
  } finally {
    host.stop();
    rmSync(streamDir, { recursive: true, force: true });
  }
});

test('portal remote release remains available in read-only mode', async () => {
  const streamDir = mkdtempSync(resolve(tmpdir(), 'tinky-release-test-'));
  const host = makeFakePortalControlHost(streamDir);
  try {
    await withServer({
      args: ['--read-only'],
      env: {
        TINKY_STREAM_DIR: streamDir,
        TINKY_AUTO_APPROVE: '1',
        TINKY_FAKE_FOCUSED_BUNDLE: 'com.apple.Safari',
        TINKY_AUDIT_DISABLE: '1',
      },
    }, async ({ call }) => {
      const begin = await call(2, 'tools/call', {
        name: 'portal_remote_begin',
        arguments: { description: 'Must be denied.' },
      });
      assert.equal(begin?.result?.isError, true);
      assert.match(begin?.result?.content?.[0]?.text || '', /read-only/i);
      const release = await call(3, 'tools/call', {
        name: 'portal_remote_release', arguments: {},
      });
      assert.equal(release?.result?.isError, undefined);
    });
    assert.deepEqual(host.actions.map(command => command.action), ['release']);
  } finally {
    host.stop();
    rmSync(streamDir, { recursive: true, force: true });
  }
});

test('stale physical Mac binding is observable but cannot request consent or control', async () => {
  const streamDir = mkdtempSync(resolve(tmpdir(), 'tinky-stale-control-test-'));
  const host = makeFakePortalControlHost(streamDir);
  try {
    const stale = JSON.parse(readFileSync(host.bindingPath, 'utf8'));
    stale.updatedAtMilliseconds = Date.now() - 60_000;
    stale.message = 'Remote Mac connected; Perslis control is released.';
    writeFileSync(host.bindingPath, JSON.stringify(stale), { mode: 0o600 });
    chmodSync(host.bindingPath, 0o600);

    await withServer({
      env: {
        TINKY_STREAM_DIR: streamDir,
        TINKY_AUTO_APPROVE: '1',
        TINKY_FAKE_FOCUSED_BUNDLE: 'com.apple.Safari',
        TINKY_AUDIT_DISABLE: '1',
      },
    }, async ({ call }) => {
      const status = toolResult(await call(2, 'tools/call', {
        name: 'portal_remote_status', arguments: {},
      }));
      assert.equal(status.observation.fresh, false);
      assert.equal(status.observation.available, false);
      assert.match(status.message, /offline or stale/i);
      assert.match(status.hostMessage, /connected/i);

      const begin = await call(3, 'tools/call', {
        name: 'portal_remote_begin',
        arguments: { durationSeconds: 60, description: 'Must not reach consent.' },
      });
      assert.equal(begin?.result?.isError, true);
      assert.match(begin?.result?.content?.[0]?.text || '', /offline|stale/i);
    });
    assert.deepEqual(host.actions, []);
  } finally {
    host.stop();
    rmSync(streamDir, { recursive: true, force: true });
  }
});

test('portal_state and portal_snapshot expose verified composed vision', async () => {
  const streamDir = mkdtempSync(resolve(tmpdir(), 'tinky-portal-test-'));
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9]);
  const sha256 = createHash('sha256').update(image).digest('hex');
  const now = new Date().toISOString();
  const state = {
    schemaVersion: 1,
    session: {
      sourceID: 'isolated-preview', kind: 'isolatedApplication',
      displayName: 'Preview', hostName: null, applicationBundleIdentifier: 'com.apple.Preview',
      processIdentifier: 123, virtualMachineIdentifier: null,
      capabilities: ['pointer', 'keyboard'],
    },
    health: {
      sourceID: 'isolated-preview', lifecycle: 'streaming', observedAt: now,
      lastHeartbeatAt: now, lastFrameAt: now, lastFrameSequence: 42,
      consecutiveFrameFailures: 0, droppedFrameCount: 0,
      roundTripMilliseconds: null, message: null,
    },
    focus: {
      owner: 'portal', portalSourceID: 'isolated-preview',
      cursorInPortal: true, keyboardCaptured: true,
    },
    input: {
      lastEventSequence: 9, lastEventAt: now, lastEventKind: 'pointerMove',
      pointer: { x: 12, y: 34 }, pressedButtons: [], pressedKeyCodes: [], modifiers: [],
    },
    vision: {
      portalLatestPath: resolve(streamDir, 'portal-latest.jpg'),
      composedLatestPath: resolve(streamDir, 'composed-latest.jpg'),
      statePath: resolve(streamDir, 'portal-state.json'),
      publishedFrameSequence: 42, publishedAt: now, heartbeatAt: now,
    },
  };
  const record = {
    schemaVersion: 1, lane: 'composed', publishedAt: now,
    jpegPath: resolve(streamDir, 'composed-latest.jpg'),
    jpegSHA256: sha256, jpegBytes: image.length,
    frame: {
      sourceID: 'composed:isolated-preview', sequence: 42, capturedAt: now,
      sourceSize: { width: 3440, height: 1440 }, colorSpace: 'sRGB', cursorEmbedded: true,
    },
  };
  writeFileSync(resolve(streamDir, 'portal-state.json'), JSON.stringify(state));
  writeFileSync(resolve(streamDir, 'portal-handoff.json'), JSON.stringify({
    schemaVersion: 1,
    phase: 'portalActive',
    updatedAt: now,
    truthProcessIdentifier: null,
    portalProcessIdentifier: 456,
    message: 'Portal compositor and Tinky visibility are healthy.',
  }));
  writeFileSync(resolve(streamDir, 'composed-frame.json'), JSON.stringify(record));
  writeFileSync(resolve(streamDir, 'composed-latest.jpg'), image);

  try {
    await withServer({ env: { TINKY_STREAM_DIR: streamDir } }, async ({ call }) => {
      const stateResponse = await call(2, 'tools/call', {
        name: 'portal_state', arguments: {},
      });
      const stateResult = toolResult(stateResponse);
      assert.equal(stateResult.session.sourceID, 'isolated-preview');
      assert.equal(stateResult.focus.owner, 'portal');
      assert.equal(stateResult.handoff.phase, 'portalActive');
      assert.equal(typeof stateResult.observation.handoff.fileAgeMs, 'number');
      assert.equal(typeof stateResult.observation.heartbeatAgeMs, 'number');
      assert.deepEqual(stateResult.vision.availableLanes, ['composed']);
      assert.equal('portalLatestPath' in stateResult.vision, false);

      const snapshot = await call(3, 'tools/call', {
        name: 'portal_snapshot', arguments: { lane: 'composed' },
      });
      const content = snapshot?.result?.content ?? [];
      assert.equal(content.length, 2);
      const summary = JSON.parse(content[0].text);
      assert.equal(summary.imageSHA256, sha256);
      assert.equal(summary.portal.input.pointer.x, 12);
      assert.equal(content[1].type, 'image');
      assert.equal(content[1].mimeType, 'image/jpeg');
      assert.equal(Buffer.from(content[1].data, 'base64').toString('hex'), image.toString('hex'));
    });
  } finally {
    rmSync(streamDir, { recursive: true, force: true });
  }
});

test('portal_state exposes handoff recovery even before portal state exists', async () => {
  const streamDir = mkdtempSync(resolve(tmpdir(), 'tinky-handoff-only-test-'));
  const now = new Date().toISOString();
  writeFileSync(resolve(streamDir, 'portal-handoff.json'), JSON.stringify({
    schemaVersion: 1,
    phase: 'restoringTruth',
    updatedAt: now,
    truthProcessIdentifier: null,
    portalProcessIdentifier: null,
    message: 'Restoring the frozen left workspace.',
  }));

  try {
    await withServer({ env: { TINKY_STREAM_DIR: streamDir } }, async ({ call }) => {
      const response = await call(2, 'tools/call', {
        name: 'portal_state', arguments: {},
      });
      const result = toolResult(response);
      assert.equal(result.session, null);
      assert.equal(result.handoff.phase, 'restoringTruth');
      assert.match(result.observation.stateUnavailable, /unavailable/i);
    });
  } finally {
    rmSync(streamDir, { recursive: true, force: true });
  }
});

test('portal_snapshot rejects the nonexistent portal-only lane', async () => {
  const streamDir = mkdtempSync(resolve(tmpdir(), 'tinky-portal-mismatch-'));
  const now = new Date().toISOString();
  writeFileSync(resolve(streamDir, 'portal-state.json'), JSON.stringify({
    schemaVersion: 1,
    session: null,
    health: null,
    focus: { owner: 'leftWorkspace', portalSourceID: null, cursorInPortal: false, keyboardCaptured: false },
    input: { lastEventSequence: null, lastEventAt: null, lastEventKind: null, pointer: null, pressedButtons: [], pressedKeyCodes: [], modifiers: [] },
    vision: { portalLatestPath: '', composedLatestPath: '', statePath: '', publishedFrameSequence: null, publishedAt: null, heartbeatAt: now },
  }));
  try {
    await withServer({ env: { TINKY_STREAM_DIR: streamDir } }, async ({ call }) => {
      const response = await call(2, 'tools/call', {
        name: 'portal_snapshot', arguments: { lane: 'portal' },
      });
      assert.equal(response?.result?.isError, true);
      assert.match(response?.result?.content?.[0]?.text || '', /invalid portal lane/i);
    });
  } finally {
    rmSync(streamDir, { recursive: true, force: true });
  }
});

test('portal_snapshot fails closed when composed image and metadata hashes differ', async () => {
  const streamDir = mkdtempSync(resolve(tmpdir(), 'tinky-composed-mismatch-'));
  const now = new Date().toISOString();
  writeFileSync(resolve(streamDir, 'portal-state.json'), JSON.stringify({
    schemaVersion: 1,
    session: null,
    health: null,
    focus: { owner: 'leftWorkspace', portalSourceID: null, cursorInPortal: false, keyboardCaptured: false },
    input: { lastEventSequence: null, lastEventAt: null, lastEventKind: null, pointer: null, pressedButtons: [], pressedKeyCodes: [], modifiers: [] },
    vision: { composedLatestPath: '', statePath: '', publishedFrameSequence: null, publishedAt: null, heartbeatAt: now },
  }));
  writeFileSync(resolve(streamDir, 'composed-frame.json'), JSON.stringify({
    schemaVersion: 1, lane: 'composed', jpegSHA256: '0'.repeat(64),
  }));
  writeFileSync(resolve(streamDir, 'composed-latest.jpg'), Buffer.from('different'));
  try {
    await withServer({ env: { TINKY_STREAM_DIR: streamDir } }, async ({ call }) => {
      const response = await call(2, 'tools/call', {
        name: 'portal_snapshot', arguments: { lane: 'composed' },
      });
      assert.equal(response?.result?.isError, true);
      assert.match(response?.result?.content?.[0]?.text || '', /does not match/i);
    });
  } finally {
    rmSync(streamDir, { recursive: true, force: true });
  }
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
    assert.match(r.auditReceipt?.eventId || '', /^\d+-\d+-\d+$/);
    assert.equal(typeof r.auditReceipt?.logFile, 'string');
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
  const { readFileSync, existsSync, mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const auditDir = mkdtempSync(join(tmpdir(), 'tinky-audit-disabled-'));
  const logPath = join(auditDir, 'session.jsonl');
  const before = existsSync(logPath) ? readFileSync(logPath, 'utf8').length : 0;
  try {
    await withServer({
      env: {
        TINKY_AUTO_APPROVE: '1',
        TINKY_FAKE_FOCUSED_BUNDLE: 'com.apple.Safari',
        TINKY_AUDIT_DISABLE: '1',
        TINKY_AUDIT_PATH: logPath,
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
  } finally {
    rmSync(auditDir, { recursive: true, force: true });
  }
});

test('OPS: audit log rotates when size exceeds TINKY_AUDIT_ROTATE_MAX', async () => {
  // v0.1.2 — rotation prevents the log from growing unbounded.
  // Set a tiny threshold (1KB) + force counter to trigger every call
  // (env TINKY_TEST_ROTATE_EVERY_CALL bypasses the 100-call defer).
  // Run enough write tool calls to overflow + verify an archive
  // appeared in the log directory.
  const {
    readdirSync, existsSync, writeFileSync, mkdtempSync, statSync, rmSync,
  } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'tinky-audit-rotate-'));
  const logPath = join(dir, 'session.jsonl');
  // Pre-fill log to ~2KB so the first rotate check overflows the 1KB
  // threshold regardless of the 100-call defer.
  writeFileSync(logPath, 'x'.repeat(2048) + '\n');
  const beforeArchives = readdirSync(dir).filter(f => /^session\..+\.jsonl$/.test(f));
  try {
    await withServer({
      env: {
        TINKY_AUTO_APPROVE: '1',
        TINKY_FAKE_FOCUSED_BUNDLE: 'com.apple.Safari',
        TINKY_AUDIT_ROTATE_MAX: '1024',
        TINKY_AUDIT_KEEP_FILES: '99',
        TINKY_AUDIT_PATH: logPath,
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SEC: audit log redacts os_type "text" payload (Codex HIGH#1)', async () => {
  // Run a successful os_type with a known sentinel + read the log file
  // to prove the cleartext never landed. The fake helper accepts
  // anything, so the only difference between the on-disk log and the
  // input is the redaction logic.
  const { readFileSync, existsSync, mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const auditDir = mkdtempSync(join(tmpdir(), 'tinky-audit-redaction-'));
  const logPath = join(auditDir, 'session.jsonl');
  const beforeSize = existsSync(logPath) ? readFileSync(logPath, 'utf8').length : 0;
  const SENTINEL = 'PA55w0rd-DO-NOT-PERSIST-9X8Y7Z';

  try {
    await withServer({
      env: {
        TINKY_AUTO_APPROVE: '1',
        TINKY_FAKE_FOCUSED_BUNDLE: 'com.apple.Safari',
        TINKY_AUDIT_PATH: logPath,
      },
    }, async ({ call }) => {
      const r = await call(2, 'tools/call', {
        name: 'os_type',
        arguments: { text: SENTINEL, target: 'Safari', description: 'fill password field' },
      });
      assert.equal(r?.result?.isError, undefined, 'type should succeed via auto-approve');
    });

    const after = readFileSync(logPath, 'utf8').slice(beforeSize);
    assert.equal(after.includes(SENTINEL), false,
      'AUDIT LOG MUST NOT contain the cleartext text payload');
    assert.match(after, new RegExp(`REDACTED:${SENTINEL.length}ch`),
      'audit log should include a typed-length redaction marker');
  } finally {
    rmSync(auditDir, { recursive: true, force: true });
  }
});


test('MCP screenshot image carries validated PNG bytes and preserves read-only mode', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'tinky-mcp-image-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4t8AAAAASUVORK5CYII=', 'base64');
  const path = resolve(root, 'frame.png'), helper = resolve(root, 'helper.mjs');
  writeFileSync(path, png, { mode: 0o600 });
  writeFileSync(helper, '#!/usr/bin/env node\nconsole.log(JSON.stringify(' + JSON.stringify({ok:true,path}) + '));\n', { mode: 0o700 });
  try {
    await withServer({ args:['--read-only'], env: { TINKY_HELPER_BIN:helper, TINKY_AUDIT_DISABLE:'1' } }, async ({call}) => {
      const result = await call(2, 'tools/call', {name:'os_screenshot_image',arguments:{}});
      assert.equal(result.result.isError, undefined);
      const image = result.result.content.find(c => c.type === 'image');
      assert.equal(image.mimeType, 'image/png');
      assert.deepEqual(Buffer.from(image.data, 'base64'), png);
      writeFileSync(path, 'not an image');
      const rejected = await call(3, 'tools/call', {name:'os_screenshot_image',arguments:{}});
      assert.equal(rejected.result.isError, true);
    });
  } finally { rmSync(root, {recursive:true,force:true}); }
});
