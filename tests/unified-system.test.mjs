import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamService } from '../src/unified/stream-service.mjs';
import { UnifiedSystem, combinedTools } from '../src/unified/system.mjs';
import { jsonResult, value } from '../src/unified/backend.mjs';

function streamFixture({ loaded = true, running = true, fps = '1', lookupError } = {}) {
  const calls = [];
  const config = { Label: 'com.tinky.tinkystream',
    ProgramArguments: ['/fixture/Applications/TinkyStream.app/Contents/MacOS/TinkyStream'],
    EnvironmentVariables: { TINKY_STREAM_FPS: fps, TINKY_STREAM_SEETHROUGH_FPS: '1', TINKY_STREAM_RING: '300' } };
  const service = new StreamService({ home: '/fixture', uid: 123,
    observe: () => ({ lanes: { full: { fresh: true } }, observedAt: 'fixture' }),
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command.endsWith('plutil')) return JSON.stringify(config);
      if (args[0] === 'print') {
        if (lookupError) throw new Error(lookupError);
        if (!loaded) throw new Error('Could not find service');
        return `state = ${running ? 'running' : 'waiting'}\npid = ${running ? 100 : 0}\n`;
      }
      if (args[0] === 'bootstrap') { loaded = true; running = true; return ''; }
      if (args[0] === 'kickstart') { running = true; return ''; }
      throw new Error('Unexpected command');
    } });
  return { service, calls };
}

test('shared running stream is reused; a close/repeated call cannot restart it', async () => {
  const { service, calls } = streamFixture();
  assert.equal((await service.ensureRunning()).started, false);
  assert.equal((await service.ensureRunning()).pid, 100);
  assert.deepEqual(calls.filter(call => ['bootstrap', 'kickstart'].includes(call.args[0])), []);
});

test('concurrent startup loads one missing stream and a stopped job uses non-killing kickstart', async () => {
  const missing = streamFixture({ loaded: false, running: false });
  await Promise.all([missing.service.ensureRunning(), missing.service.ensureRunning()]);
  assert.equal(missing.calls.filter(call => call.args[0] === 'bootstrap').length, 1);
  const stopped = streamFixture({ running: false });
  assert.equal((await stopped.service.ensureRunning()).running, true);
  assert.deepEqual(stopped.calls.find(call => call.args[0] === 'kickstart').args,
    ['kickstart', 'gui/123/com.tinky.tinkystream']);
});

test('unsafe capture rates or inaccessible launchd fail before starting a producer', async () => {
  const unsafe = streamFixture({ loaded: false, fps: '15' });
  await assert.rejects(unsafe.service.ensureRunning(), /≤1 FPS/);
  assert.equal(unsafe.calls.filter(call => call.command.endsWith('launchctl')).length, 0);
  const inaccessible = streamFixture({ lookupError: 'Operation not permitted' });
  await assert.rejects(inaccessible.service.ensureRunning(), /Operation not permitted/);
  assert.equal(inaccessible.calls.filter(call => call.args[0] === 'bootstrap').length, 0);
});

function systemFixture(readOnly = false) {
  const calls = [];
  const definitions = names => names.map(name => ({ name, inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: ['session_frame', 'frame_history', 'setup_status', 'vision_find_text', 'os_screenshot'].includes(name) } }));
  const isolated = { ready: true, info: { name: 'native' }, transport: { pid: 1 },
    tools: definitions(['session_frame', 'frame_history', 'click', 'type_text', 'key_press', 'setup_status']),
    call: async (name, args) => {
      calls.push({ backend: 'isolated', name, args });
      if (name === 'session_frame') {
        if (args.sessionId !== 'owned') throw new Error('Session not found');
        return jsonResult({ path: '/owned-frame.png', width: 230, height: 408 });
      }
      return jsonResult({ success: true });
    } };
  const vision = { ready: true, info: { name: 'vision' }, transport: { pid: 2 },
    tools: definitions(['vision_find_text', 'os_screenshot', 'os_click', 'os_type', 'os_key']),
    call: async (name, args) => {
      calls.push({ backend: 'vision', name, args });
      if (name === 'os_click') return { isError: true, content: [{ type: 'text', text: 'deny-list' }] };
      return jsonResult({ matches: [{ text: '15' }] });
    } };
  let starts = 0;
  const stream = { ensureRunning: async () => { starts++; return { running: true, pid: 3 }; } };
  return { system: new UnifiedSystem(isolated, vision, stream, { readOnly }), calls,
    starts: () => starts, isolated, vision };
}

test('one observation uses native capture, OCR of those exact bytes and recording from the same session', async () => {
  const { system, calls, starts } = systemFixture();
  const observation = value(await system.call('observe_session', { sessionId: 'owned' }));
  assert.equal(observation.frame.path, '/owned-frame.png');
  assert.equal(observation.vision.matches[0].text, '15');
  assert.deepEqual(calls, [
    { backend: 'isolated', name: 'session_frame', args: { sessionId: 'owned' } },
    { backend: 'vision', name: 'vision_find_text', args: { inPath: '/owned-frame.png' } },
    { backend: 'isolated', name: 'frame_history', args: { sessionId: 'owned', limit: 1 } },
  ]);
  assert.equal(starts(), 1);
});

test('session-scoped input reaches only native input and translates key modifiers', async () => {
  const { system, calls } = systemFixture();
  await system.call('os_click', { sessionId: 'owned', x: 33, y: 212 });
  await system.call('os_type', { sessionId: 'owned', text: '+8=' });
  await system.call('os_key', { sessionId: 'owned', key: 'a', cmd: true, opt: true });
  assert.deepEqual(calls, [
    { backend: 'isolated', name: 'click', args: { sessionId: 'owned', x: 33, y: 212 } },
    { backend: 'isolated', name: 'type_text', args: { sessionId: 'owned', text: '+8=' } },
    { backend: 'isolated', name: 'key_press', args: { sessionId: 'owned', key: 'a', modifiers: ['cmd', 'option'] } },
  ]);
});

test('invalid/missing sessions and unsupported double-click never become host actions', async () => {
  const { system, calls } = systemFixture();
  await assert.rejects(system.call('os_click', { sessionId: '', x: 1, y: 2 }), /nonempty sessionId/);
  await assert.rejects(system.call('os_click', { sessionId: 'owned', x: 1, y: 2, double: true }), /does not expose double-click/);
  await assert.rejects(system.call('vision_find_text', { sessionId: 'foreign' }), /Session not found/);
  await assert.rejects(system.call('vision_find_text', { sessionId: 'owned', inPath: '/other.png' }), /not both/);
  assert.equal(calls.some(call => call.backend === 'vision'), false);
});

test('unscoped host tools preserve their consent/deny result and read-only blocks both input routes', async () => {
  const fixture = systemFixture();
  const args = { x: 10, y: 20, target: 'sensitive', description: 'blocked' };
  assert.equal((await fixture.system.call('os_click', args)).isError, true);
  assert.deepEqual(fixture.calls, [{ backend: 'vision', name: 'os_click', args }]);
  const readOnly = systemFixture(true);
  await assert.rejects(readOnly.system.call('os_click', { sessionId: 'owned', x: 1, y: 2 }), /read-only/);
  await assert.rejects(readOnly.system.call('type_text', { sessionId: 'owned', text: 'x' }), /read-only/);
  assert.equal(readOnly.calls.length, 0);
});

test('combined inventory rejects collisions and setup identifies all components', async () => {
  const fixture = systemFixture();
  assert.throws(() => combinedTools(fixture.isolated.tools, fixture.isolated.tools), /collide/);
  const setup = value(await fixture.system.call('setup_status'));
  assert.equal(setup.unified, true);
  assert.equal(setup.toolCount, fixture.system.tools.length);
  assert.equal(setup.components.tinkyStream.running, true);
  const legacyRead = { name: 'vision_find_text', inputSchema: { type: 'object', properties: {} } };
  assert.equal(combinedTools([], [legacyRead])[0].annotations.readOnlyHint, true);
});
