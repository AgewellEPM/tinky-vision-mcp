// Local TinkyStream observations. Physical and composed frames have independent
// freshness: an old GhostBridge portal must never hide a healthy physical feed.
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = () => process.env.TINKY_STREAM_DIR || join(homedir(), '.kist/runs/desktop-vision-console/stream');
const cache = () => process.env.TINKY_SNAPSHOT_DIR || join(homedir(), 'Library/Caches/tinky-vision-mcp');
const files = { full: 'latest.jpg', seethrough: 'seethrough-latest.jpg', composed: 'composed-latest.jpg' };
const MAX_AGE = 5000;

function read(name, max = 32 * 1024 * 1024) {
  const path = join(root(), name);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || info.size <= 0 || info.size > max) {
      throw new Error(`Invalid stream file: ${name}`);
    }
    const data = readFileSync(fd);
    if (data.length !== info.size) throw new Error(`Stream file changed while reading: ${name}`);
    return { path, data, ageMs: Math.max(0, Date.now() - info.mtimeMs) };
  } finally { closeSync(fd); }
}

function json(name) { return JSON.parse(read(name, 1024 * 1024).data.toString('utf8')); }

function laneFrame(lane) {
  if (!Object.hasOwn(files, lane)) throw new Error(`Unknown stream lane: ${lane}`);
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    const frame = read(files[lane]);
    const sha256 = createHash('sha256').update(frame.data).digest('hex');
    if (lane !== 'composed') return { ...frame, sha256, source: 'physical-display', lane };
    const record = json('composed-frame.json');
    const capturedAt = Date.parse(record.frame?.capturedAt);
    if (record.schemaVersion === 1 && record.lane === lane &&
        record.jpegSHA256 === sha256 && Number.isFinite(capturedAt)) {
      return { ...frame, sha256, lane, source: record.frame.sourceID,
        capturedAt: record.frame.capturedAt,
        ageMs: Math.max(frame.ageMs, Date.now() - capturedAt) };
    }
    last = new Error('Composed frame does not match its capture metadata');
  }
  throw last;
}

export function portalState() {
  const lanes = {};
  for (const lane of Object.keys(files)) {
    try {
      const { data, ...frame } = laneFrame(lane);
      lanes[lane] = { ...frame, bytes: data.length, fresh: frame.ageMs <= MAX_AGE };
    } catch (error) { lanes[lane] = { fresh: false, error: error.message }; }
  }
  let portal = null;
  try {
    const state = json('portal-state.json');
    const ageMs = Date.now() - Date.parse(state.health?.observedAt);
    portal = { session: state.session, health: state.health,
      fresh: Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= MAX_AGE };
  } catch (error) { portal = { fresh: false, error: error.message }; }
  return { ok: true, lanes, portal, observedAt: new Date().toISOString() };
}

export function portalSnapshot(lane = 'full') {
  const { data, ...frame } = laneFrame(lane);
  if (frame.ageMs > MAX_AGE) throw new Error(`${lane} stream is stale (${Math.round(frame.ageMs)}ms); no live snapshot returned`);
  mkdirSync(cache(), { recursive: true, mode: 0o700 });
  const path = join(cache(), `stream-${randomUUID()}.jpg`);
  writeFileSync(path, data, { flag: 'wx', mode: 0o600 });
  return { ok: true, ...frame, sourcePath: frame.path, path, bytes: data.length,
    coordinateSpace: lane === 'composed' ? 'composed-image' : 'physical-display-image',
    note: 'Observation only. Use IsolatedTester session_frame and session-scoped input for an isolated app.' };
}

export const STREAM_TOOLS = [
  { name: 'portal_state', description: 'Read independent freshness of TinkyStream full, see-through and composed lanes plus GhostBridge portal state. Local only; stale portal state does not block the physical feed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'portal_snapshot', description: 'Freeze a fresh TinkyStream frame to a private local image file for observation/OCR. Defaults to the physical full lane; composed requires matching capture metadata. Refuses stale footage. Does not control an isolated app.',
    inputSchema: { type: 'object', properties: { lane: { type: 'string', enum: ['full', 'seethrough', 'composed'] } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
];
