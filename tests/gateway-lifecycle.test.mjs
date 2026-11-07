import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { startSystem } from '../src/unified/system.mjs';

function fixture(gate = Promise.resolve()) {
  const calls = [];
  const backend = name => ({
    ready: false, tools: [], info: { name }, transport: { pid: 1 },
    async connect() { await gate; this.ready = true; },
    async close(options) { calls.push({ name, options }); this.ready = false; },
  });
  const isolated = backend('isolated'), vision = backend('vision');
  const input = new PassThrough(), output = new PassThrough();
  const stream = { ensureRunning: async () => ({ pid: null }) };
  return { isolated, vision, stream, input, output, calls };
}

async function cleaned(fixture) {
  for (let attempt = 0; attempt < 100 && fixture.calls.length < 2; attempt++) await delay(5);
  assert.deepEqual(fixture.calls, [
    { name: 'isolated', options: { stopSessions: true } },
    { name: 'vision', options: undefined },
  ]);
  await delay(0);
}

test('client EOF closes both owned backends exactly once', async () => {
  const f = fixture();
  await startSystem(f);
  assert.equal(f.calls.length, 0, 'an attached connection stays running');
  f.input.end();
  await cleaned(f);
  f.input.destroy();
  await delay(10);
  assert.equal(f.calls.length, 2);
});

test('a client disappearing during startup still closes late backends', async () => {
  let release;
  const f = fixture(new Promise(resolve => { release = resolve; }));
  const starting = startSystem(f);
  f.input.destroy();
  await delay(0);
  release();
  await starting;
  await cleaned(f);
});

test('broken output closes the connection and removes shutdown listeners', async () => {
  const previous = process.listenerCount('SIGTERM');
  const f = fixture();
  await startSystem(f);
  f.output.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
  await cleaned(f);
  assert.equal(process.listenerCount('SIGTERM'), previous);
  assert.equal(f.input.listenerCount('end'), 0);
});

test('already closed input does not start backends', async () => {
  const f = fixture();
  f.input.destroy();
  await startSystem(f);
  assert.equal(f.isolated.ready, false);
  assert.equal(f.vision.ready, false);
  assert.equal(f.calls.length, 0);
});
