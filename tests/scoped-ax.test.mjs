import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScopedAXBridge, SCOPED_AX_TOOLS, parseScopedAXFrame, redactScopedAXAuditArgs,
  MAX_SCOPED_AX_RESPONSE } from '../src/scoped-ax.mjs';
import { makeScopedAXManifest, SCOPED_AX_SERVER_FILES } from '../src/scoped-ax-helper.mjs';

const SERVER = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const FIXTURE = `
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const argv = process.argv.slice(2);
const session = argv[argv.indexOf('--session-id') + 1];
const windowToken = randomUUID(), target = randomUUID(), element = randomUUID();
let generation = 0, remaining = 8, busy = false;
if(config.mode==='timeout_press_ignore_term') {process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
appendFileSync(config.events, JSON.stringify({kind:'startup',pid:process.pid,argv,
  auto:process.env.TINKY_AUTO_APPROVE ?? null,dyld:process.env.DYLD_INSERT_LIBRARIES ?? null})+'\\n');
const input = createInterface({input:process.stdin});
input.on('line', line => {
 const request = JSON.parse(line);
 appendFileSync(config.events, JSON.stringify({kind:'request',pid:process.pid,...request,busy})+'\\n');
 if (busy) { process.stdout.write('{}\\n'); return; }
 busy = true;
 const response = {schema_version:1,request_id:request.request_id,session_id:session,
  operation:request.operation,disposition:'observed',code:'fixture_observed',message:'Fixture only.',accepted:false};
 switch(request.operation) {
 case 'targets': response.targets = [{window_token:windowToken,pid:request.arguments.pid,
  bundle_id:'example.fixture',app_name:'Fixture',window_title:'Fixture document',executable_sha256:'a'.repeat(64)}]; break;
 case 'enroll': Object.assign(response,{target_handle:target,expires_in_seconds:300,remaining_presses:8,
  identity:{pid:123,process_start_unix_microseconds:'1700000000000000',bundle_id:'example.fixture',
   executable_path:'/fixture/native-app',executable_sha256:config.mode==='wrong_identity'?'b'.repeat(64):'a'.repeat(64),
   window_title:'Fixture document'}}); break;
 case 'snapshot': Object.assign(response,{target_handle:target,tree_generation:++generation,
  elements:[{element_token:element,role:'AXButton',label:'Fixture button',pressable:config.mode!=='unpressable'}],truncated:false}); break;
 case 'press':
  if(config.mode==='crash_press') process.exit(9);
  if(['timeout_press','timeout_press_ignore_term'].includes(config.mode)) return;
  Object.assign(response,{action_id:request.arguments.action_id,target_handle:target,
   tree_generation:++generation,remaining_presses:--remaining,dispatch_observed:true});
  if(config.mode==='unknown_press') Object.assign(response,{disposition:'unknown',code:'fixture_unknown'});
  break;
 case 'release': response.released=true; break;
 }
 setTimeout(()=>{
  let raw=JSON.stringify(response)+'\\n';
  if(request.operation==='targets') {
   if(config.mode==='wrong_session') raw=raw.replace(session,randomUUID());
   if(config.mode==='duplicate') raw=raw.replace('"accepted":false','"accepted":true,"accepted":false');
   if(config.mode==='escaped_duplicate') raw=raw.replace('"accepted":false','"accept\\\\u0065d":true,"accepted":false');
   if(config.mode==='concatenated') raw+=raw;
   if(config.mode==='oversized') raw='x'.repeat(262145)+'\\n';
   if(config.mode==='accepted') raw=raw.replace('"accepted":false','"accepted":true');
   if(config.mode==='invalid_utf8') {process.stdout.write(Buffer.from([255,10]));busy=false;return;}
  }
  process.stdout.write(raw);busy=false;
 },config.delay??0);
});
input.on('close',()=>{if(config.mode!=='timeout_press_ignore_term')process.exit(0);});
`;

function fixture(mode = 'normal', extra = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tinky-scoped-ax-fixture-')));
  const helper = join(root, 'helper.mjs');
  const events = join(root, 'events.jsonl');
  writeFileSync(helper, `#!${process.execPath}\n${FIXTURE}`, { mode: 0o700 });
  const repository = fileURLToPath(new URL('..', import.meta.url));
  const hashes = Object.fromEntries(SCOPED_AX_SERVER_FILES.map(name => [name,
    createHash('sha256').update(readFileSync(join(repository, name))).digest('hex')]));
  writeFileSync(helper + '.manifest.json', JSON.stringify(makeScopedAXManifest(readFileSync(helper), hashes)), { mode: 0o600 });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ mode, events, ...extra }), { mode: 0o600 });
  return { root, helper, events,
    readEvents() { return existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; },
    remove() { rmSync(root, { recursive: true, force: true }); } };
}

async function withBridge(mode, body, options = {}, extra = {}) {
  const files = fixture(mode, extra);
  const children = [];
  const calls = [];
  const bridge = new ScopedAXBridge({ helperPath: files.helper,
    spawnImpl: (path, args, config) => {
      calls.push({ path, args, config });
      const child = spawn(path, args, config);
      children.push(child); return child;
    }, ...options });
  try { return await body({ bridge, files, calls, children }); }
  finally {
    await bridge.close();
    for (const child of children) {
      assert.ok(child.exitCode !== null || child.signalCode !== null, 'fixture helper stopped');
      if (child.pid) assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    }
    files.remove();
  }
}

async function enrolled(bridge) {
  const targets = await bridge.request('targets', { pid: 123 });
  assert.equal(targets.disposition, 'observed');
  const enrollment = await bridge.request('enroll', { window_token: targets.targets[0].window_token, purpose: 'Fixture only' });
  assert.equal(enrollment.disposition, 'observed');
  return { targets, enrollment, handle: enrollment.target_handle };
}

async function observedElement(bridge, handle) {
  const snapshot = await bridge.request('snapshot', { target_handle: handle });
  assert.equal(snapshot.disposition, 'observed');
  return { target_handle: handle, tree_generation: snapshot.tree_generation,
    element_token: snapshot.elements[0].element_token, action_id: randomUUID() };
}

test('scoped tool schemas are closed and audit contains no opaque argument values', () => {
  assert.equal(SCOPED_AX_TOOLS.length, 5);
  for (const tool of SCOPED_AX_TOOLS) assert.equal(tool.inputSchema.additionalProperties, false);
  const secret = randomUUID();
  const audit = redactScopedAXAuditArgs('press', { target_handle: secret, action_id: secret,
    element_token: secret, tree_generation: 2, [secret]: { password: secret } });
  assert.ok(!JSON.stringify(audit).includes(secret));
  assert.deepEqual(audit.supplied_fields, ['target_handle', 'tree_generation', 'element_token', 'action_id']);
});

test('bounded parser refuses duplicate, escaped duplicate, multiple frames, malformed UTF8 and depth', () => {
  assert.deepEqual(parseScopedAXFrame(Buffer.from('{"x":[1,true,"ok"]}')), { x: [1, true, 'ok'] });
  for (const value of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{}{}', '[[[[[[[[[[0]]]]]]]]]]']) {
    assert.throws(() => parseScopedAXFrame(Buffer.from(value)));
  }
  assert.throws(() => parseScopedAXFrame(Buffer.from([255])));
  assert.throws(() => parseScopedAXFrame(Buffer.alloc(MAX_SCOPED_AX_RESPONSE + 1)));
});

test('invalid arguments, unknown handles, and oversized purpose never spawn helper', async () => {
  await withBridge('normal', async ({ bridge, calls }) => {
    for (const [operation, args] of [
      ['targets', { pid: 123, auto_approve: true }], ['targets', { pid: '123' }],
      ['enroll', { window_token: randomUUID(), purpose: 'x'.repeat(65536) }],
      ['enroll', { window_token: randomUUID().toUpperCase(), purpose: 'Fixture' }],
      ['snapshot', { target_handle: randomUUID() }], ['release', { target_handle: randomUUID() }],
    ]) assert.equal((await bridge.request(operation, args)).disposition, 'denied');
    assert.equal(calls.length, 0);
  });
});

test('read-only refuses enrollment and press without consent or AUTO_APPROVE fallback', async () => {
  await withBridge('normal', async ({ bridge, calls, files }) => {
    const target = await bridge.request('targets', { pid: 123 });
    const enrollment = await bridge.request('enroll', { window_token: target.targets[0].window_token, purpose: 'Fixture' });
    assert.equal(enrollment.code, 'bridge_read_only');
    const press = await bridge.request('press', { target_handle: randomUUID(), tree_generation: 1,
      element_token: randomUUID(), action_id: randomUUID() });
    assert.equal(press.code, 'bridge_read_only');
    assert.ok(calls[0].args.includes('--read-only'));
    assert.deepEqual(files.readEvents().filter(item => item.kind === 'request').map(item => item.operation), ['targets']);
  }, { readOnly: true });
});

test('lazy session passes additive deny settings with minimal environment and exact round-trip bindings', async () => {
  await withBridge('normal', async ({ bridge, calls, files }) => {
    assert.equal(calls.length, 0);
    const { targets, enrollment, handle } = await enrolled(bridge);
    assert.equal(targets.session_id, enrollment.session_id);
    assert.equal(enrollment.accepted, false);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['scoped-ax', '--session-id', enrollment.session_id,
      '--deny-bundle', 'example.denied', '--deny-bundle', 'com.apple.Terminal']);
    assert.deepEqual(Object.keys(calls[0].config.env).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH']);
    assert.equal(files.readEvents()[0].auto, null);
    assert.equal(files.readEvents()[0].dyld, null);
    const release = await bridge.request('release', { target_handle: handle });
    assert.equal(release.released, true);
    assert.equal((await bridge.request('snapshot', { target_handle: handle })).code, 'bridge_target_revoked');
    assert.equal(calls.length, 1);
  }, { denyBundles: ['example.denied', 'com.apple.Terminal'] });
});

test('one in-flight frame and bounded queue serialize native requests', async () => {
  await withBridge('normal', async ({ bridge, files }) => {
    const results = await Promise.all(Array.from({ length: 4 }, () => bridge.request('targets', { pid: 123 })));
    assert.deepEqual(results.map(item => item.disposition), ['observed', 'observed', 'denied', 'denied']);
    assert.equal(results[2].code, 'bridge_queue_full');
    const observed = files.readEvents().filter(item => item.kind === 'request');
    assert.equal(observed.length, 2);
    assert.ok(observed.every(item => item.busy === false));
    assert.equal(new Set(observed.map(item => item.request_id)).size, 2);
  }, { maximumQueue: 2 }, { delay: 15 });
});

test('press requires fresh observed element and action UUID; receipt never accepts task success', async () => {
  await withBridge('normal', async ({ bridge, files }) => {
    const { handle } = await enrolled(bridge);
    const action = await observedElement(bridge, handle);
    assert.equal((await bridge.request('press', { ...action, element_token: randomUUID() })).code, 'bridge_stale_element');
    const response = await bridge.request('press', action);
    assert.equal(response.disposition, 'observed');
    assert.equal(response.dispatch_observed, true);
    assert.equal(response.accepted, false);
    assert.equal(response.remaining_presses, 7);
    assert.equal((await bridge.request('press', action)).code, 'bridge_action_already_used');
    assert.equal((await bridge.request('press', { ...action, action_id: randomUUID() })).code, 'bridge_stale_element');
    assert.equal(files.readEvents().filter(item => item.operation === 'press').length, 1);
  });
});

test('a nonpressable observation cannot be promoted to AXPress', async () => {
  await withBridge('unpressable', async ({ bridge, files }) => {
    const { handle } = await enrolled(bridge);
    const action = await observedElement(bridge, handle);
    assert.equal((await bridge.request('press', action)).code, 'bridge_stale_element');
    assert.equal(files.readEvents().filter(item => item.operation === 'press').length, 0);
  });
});

test('native identity mismatch revokes the new enrollment', async () => {
  await withBridge('wrong_identity', async ({ bridge, calls }) => {
    const targets = await bridge.request('targets', { pid: 123 });
    assert.equal((await bridge.request('enroll', { window_token: targets.targets[0].window_token,
      purpose: 'Fixture' })).code, 'bridge_invalid_response');
    assert.equal((await bridge.request('enroll', { window_token: targets.targets[0].window_token,
      purpose: 'Fixture' })).code, 'bridge_window_revoked');
    assert.equal(calls.length, 1);
  });
});

for (const mode of ['wrong_session', 'duplicate', 'escaped_duplicate', 'concatenated', 'oversized', 'accepted', 'invalid_utf8']) {
  test(`native ${mode} output is refused without fallback`, async () => {
    await withBridge(mode, async ({ bridge, calls }) => {
      const response = await bridge.request('targets', { pid: 123 });
      assert.equal(response.disposition, 'denied');
      assert.equal(response.accepted, false);
      assert.equal(calls.length, 1);
      assert.ok(['bridge_invalid_response', 'bridge_output_limit'].includes(response.code));
    });
  });
}

for (const mode of ['crash_press', 'timeout_press', 'unknown_press']) {
  test(`${mode} returns unknown, never replays and never restarts an existing handle`, async () => {
    await withBridge(mode, async ({ bridge, calls, files }) => {
      const { handle, targets } = await enrolled(bridge);
      const action = await observedElement(bridge, handle);
      const response = await bridge.request('press', action);
      assert.equal(response.disposition, 'unknown');
      assert.equal(response.accepted, false);
      assert.equal((await bridge.request('press', action)).code, 'bridge_action_already_used');
      assert.equal((await bridge.request('snapshot', { target_handle: handle })).code, 'bridge_target_revoked');
      assert.equal(calls.length, 1);
      assert.equal(files.readEvents().filter(item => item.operation === 'press').length, 1);
      const fresh = await bridge.request('targets', { pid: 123 });
      assert.equal(fresh.disposition, 'observed');
      assert.notEqual(fresh.session_id, targets.session_id);
      assert.equal((await bridge.request('enroll', { window_token: targets.targets[0].window_token,
        purpose: 'Fixture' })).code, 'bridge_window_revoked');
      assert.equal(calls.length, 2);
    }, { timeoutMs: mode === 'timeout_press' ? 150 : 1000 });
  });
}

test('closing during a press returns unknown, rejects queued work, and stops owned helper', async () => {
  await withBridge('timeout_press', async ({ bridge, files }) => {
    const { handle } = await enrolled(bridge);
    const action = await observedElement(bridge, handle);
    const pending = bridge.request('press', action);
    for (let count = 0; count < 50 && !files.readEvents().some(item => item.operation === 'press'); count++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(files.readEvents().some(item => item.operation === 'press'));
    const queued = bridge.request('targets', { pid: 123 });
    await bridge.close();
    assert.equal((await pending).disposition, 'unknown');
    assert.equal((await queued).code, 'bridge_closed');
    assert.equal((await bridge.request('targets', { pid: 123 })).code, 'bridge_closed');
  });
});

test('fresh discovery waits for actual old-helper close after ignored TERM and EOF', async () => {
  await withBridge('timeout_press_ignore_term', async ({ bridge, calls, children }) => {
    const { handle } = await enrolled(bridge);
    const action = await observedElement(bridge, handle);
    assert.equal((await bridge.request('press', action)).disposition, 'unknown');
    const old = children[0];
    assert.equal(old.exitCode, null);
    assert.equal(old.signalCode, null);
    const began = Date.now();
    const discovery = await bridge.request('targets', { pid: 123 });
    assert.equal(discovery.disposition, 'observed');
    assert.ok(Date.now() - began >= 150, 'fresh helper cannot overlap ignored-TERM cleanup');
    assert.equal(old.signalCode, 'SIGKILL');
    assert.equal(calls.length, 2);
    assert.throws(() => process.kill(old.pid, 0), { code: 'ESRCH' });
  }, { timeoutMs: 150 });
});

test('MCP preserves substrate refusal before helper startup and never audits opaque scoped arguments', async () => {
  const files = fixture();
  const audit = join(files.root, 'audit.jsonl');
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TINKY_HELPER_BIN: files.helper, TINKY_SCOPED_AX_HELPER_BIN: files.helper, TINKY_AUDIT_PATH: audit,
      TINKY_AUDIT_DISABLE: '0', TINKY_AUTO_APPROVE: '1', TINKY_DENY_BUNDLES: 'example.extra.denied' } });
  let buffer = '', id = 0, diagnostics = '';
  const pending = new Map();
  child.stderr.on('data', data => { diagnostics += data; assert.ok(diagnostics.length < 65536); });
  child.stdout.on('data', data => {
    buffer += data;
    assert.ok(buffer.length < 1048576);
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      const message = JSON.parse(line);
      if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    }
  });
  const call = async (method, params) => {
    const requestID = ++id;
    return new Promise((resolveResponse, reject) => {
      const timeout = setTimeout(() => { pending.delete(requestID); reject(new Error('Fixture MCP timeout')); }, 3000);
      pending.set(requestID, response => { clearTimeout(timeout); resolveResponse(response); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestID, method, params }) + '\n');
    });
  };
  const tool = async (name, args) => {
    const response = await call('tools/call', { name, arguments: args });
    assert.equal(response.result?.isError, undefined);
    return JSON.parse(response.result.content[0].text);
  };
  let helperPID = null;
  try {
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'scoped-fixture', version: '1' } });
    const listed = await call('tools/list', {});
    const names = listed.result.tools.map(item => item.name);
    assert.ok(names.includes('os_click') && names.includes('os_type') && names.includes('portal_state'));
    for (const item of SCOPED_AX_TOOLS) assert.ok(names.includes(item.name));
    const refusedToken = randomUUID();
    const refusal = await call('tools/call', { name: 'os_ax_enroll', arguments: {
      window_token: refusedToken, purpose: 'Run launchctl kickstart -k com.kist.runtime',
    } });
    assert.equal(refusal.result?.isError, true);
    assert.match(refusal.result.content[0].text, /self-substrate protection/);
    assert.deepEqual(files.readEvents(), [], 'existing substrate policy runs before helper startup or consent');
    const targets = await tool('os_ax_targets', { pid: 123 });
    const enrollment = await tool('os_ax_enroll', { window_token: targets.targets[0].window_token, purpose: 'Fixture only' });
    const snapshot = await tool('os_ax_snapshot', { target_handle: enrollment.target_handle });
    const actionID = randomUUID();
    const press = await tool('os_ax_press', { target_handle: enrollment.target_handle,
      tree_generation: snapshot.tree_generation, element_token: snapshot.elements[0].element_token, action_id: actionID });
    assert.equal(press.disposition, 'observed');
    assert.equal(press.accepted, false);
    assert.ok(press.auditReceipt?.eventId);
    const auditText = readFileSync(audit, 'utf8');
    for (const secret of [targets.targets[0].window_token, enrollment.target_handle,
      snapshot.elements[0].element_token, actionID, enrollment.session_id, refusedToken]) assert.ok(!auditText.includes(secret));
    const startup = files.readEvents().find(item => item.kind === 'startup');
    helperPID = startup.pid;
    assert.ok(startup.argv.includes('example.extra.denied') && startup.argv.includes('com.apple.Terminal'));
    assert.equal(startup.auto, null);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolveExit, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolveExit(); return; }
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Fixture MCP cleanup timeout')); }, 3000);
      child.once('exit', () => { clearTimeout(timeout); resolveExit(); });
    });
    if (helperPID) assert.throws(() => process.kill(helperPID, 0), { code: 'ESRCH' });
    files.remove();
  }
});
