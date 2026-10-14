import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { portalState, portalSnapshot } from '../src/stream-vision.mjs';

test('fresh physical feed survives a stale portal; snapshot bytes stay frozen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tinky-stream-'));
  process.env.TINKY_STREAM_DIR = dir;
  process.env.TINKY_SNAPSHOT_DIR = join(dir, 'snapshots');
  try {
    writeFileSync(join(dir, 'latest.jpg'), 'current physical frame');
    writeFileSync(join(dir, 'portal-state.json'), JSON.stringify({ health: { observedAt: '2020-01-01' } }));
    const state = portalState();
    assert.equal(state.lanes.full.fresh, true);
    assert.equal(state.portal.fresh, false);
    const frozen = portalSnapshot();
    writeFileSync(join(dir, 'latest.jpg'), 'new frame');
    assert.equal(readFileSync(frozen.path, 'utf8'), 'current physical frame');
    utimesSync(join(dir, 'latest.jpg'), 1, 1);
    assert.throws(() => portalSnapshot(), /stale/);
  } finally {
    delete process.env.TINKY_STREAM_DIR; delete process.env.TINKY_SNAPSHOT_DIR;
    rmSync(dir, { recursive: true });
  }
});

test('composed frames require matching hashes and fresh original capture time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tinky-composed-'));
  process.env.TINKY_STREAM_DIR = dir;
  try {
    const bytes = Buffer.from('old composed image');
    writeFileSync(join(dir, 'composed-latest.jpg'), bytes);
    const record = { schemaVersion: 1, lane: 'composed', jpegSHA256: 'wrong',
      frame: { capturedAt: new Date().toISOString(), sourceID: 'fixture' } };
    writeFileSync(join(dir, 'composed-frame.json'), JSON.stringify(record));
    assert.throws(() => portalSnapshot('composed'), /does not match/);
    record.jpegSHA256 = createHash('sha256').update(bytes).digest('hex');
    record.frame.capturedAt = '2020-01-01T00:00:00Z';
    writeFileSync(join(dir, 'composed-frame.json'), JSON.stringify(record));
    assert.throws(() => portalSnapshot('composed'), /stale/);
  } finally {
    delete process.env.TINKY_STREAM_DIR;
    rmSync(dir, { recursive: true });
  }
});
