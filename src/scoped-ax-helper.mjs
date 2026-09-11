// Deployment matching for the independent scoped helper. This is artifact
// consistency, not native consent, task authority, or a containment receipt.
import { constants, openSync, closeSync, fstatSync, readSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { parseScopedAXFrame } from './scoped-ax.mjs';

export const SCOPED_AX_PRODUCT = 'tinky-os-scoped-ax';
export const SCOPED_AX_PROTOCOL = 'tinky.scoped-ax.v1';
export const SCOPED_AX_SERVER_FILES = Object.freeze([
  'src/server.mjs', 'src/scoped-ax.mjs', 'src/scoped-ax-helper.mjs', 'src/tool-metadata.mjs',
]);
const SHA256 = /^[a-f0-9]{64}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const refuse = () => { throw new Error('Matching scoped Accessibility helper is unavailable; stage the independent helper. Legacy tools were not used.'); };

export function scopedAXHelperPath(repositoryRoot, environment = process.env) {
  const value = environment.TINKY_SCOPED_AX_HELPER_BIN;
  if (value !== undefined && (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0'))) refuse();
  // Deliberately never consult TINKY_HELPER_BIN, tinky-os-ax, or tinky-os.
  return value === undefined ? resolve(repositoryRoot, 'bin', SCOPED_AX_PRODUCT) : value;
}

function fingerprint(info) {
  return [info.dev, info.ino, info.size, info.uid, info.mode, info.nlink, info.mtimeMs, info.ctimeMs].join(':');
}

function readRegular(path, maximum, executable = false) {
  if (!isAbsolute(path) || realpathSync(path) !== path) refuse();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || ![0, process.getuid()].includes(before.uid)
      || (before.mode & 0o022) !== 0 || before.size <= 0 || before.size > maximum
      || (executable && (before.mode & 0o111) === 0)) refuse();
    const chunks = [];
    let total = 0;
    while (total <= maximum) {
      const chunk = Buffer.alloc(Math.min(65536, maximum + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count; chunks.push(chunk.subarray(0, count));
    }
    if (total > maximum) refuse();
    const bytes = Buffer.concat(chunks, total);
    if (bytes.length !== before.size || fingerprint(fstatSync(fd)) !== fingerprint(before)
      || realpathSync(path) !== path) refuse();
    // Re-open the exact name to reject replacement while the old descriptor stayed valid.
    const named = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { if (fingerprint(fstatSync(named)) !== fingerprint(before)) refuse(); }
    finally { closeSync(named); }
    return bytes;
  } finally { closeSync(fd); }
}

export function makeScopedAXManifest(helperBytes, serverHashes, buildInputs = {}) {
  if (!Buffer.isBuffer(helperBytes) || helperBytes.length === 0
    || Object.keys(serverHashes).sort().join('\0') !== [...SCOPED_AX_SERVER_FILES].sort().join('\0')
    || Object.values(serverHashes).some(value => !SHA256.test(value))) refuse();
  return { schema_version: 1, product: SCOPED_AX_PRODUCT, protocol: SCOPED_AX_PROTOCOL,
    helper_sha256: digest(helperBytes), server_sha256: { ...serverHashes }, build_inputs: { ...buildInputs },
    native_consent_verified: false, accepted: false, hard_containment: false };
}

export function validateScopedAXHelper(repositoryRoot, helperPath) {
  try {
    const raw = readRegular(helperPath + '.manifest.json', 256 * 1024);
    const manifest = parseScopedAXFrame(raw);
    if (!manifest || manifest.schema_version !== 1 || manifest.product !== SCOPED_AX_PRODUCT
      || manifest.protocol !== SCOPED_AX_PROTOCOL || manifest.accepted !== false
      || manifest.hard_containment !== false || manifest.native_consent_verified !== false
      || !SHA256.test(manifest.helper_sha256) || !manifest.server_sha256
      || Object.keys(manifest.server_sha256).sort().join('\0') !== [...SCOPED_AX_SERVER_FILES].sort().join('\0')) refuse();
    const helper = readRegular(helperPath, 32 * 1024 * 1024, true);
    if (digest(helper) !== manifest.helper_sha256) refuse();
    for (const relative of SCOPED_AX_SERVER_FILES) {
      const source = readRegular(resolve(repositoryRoot, relative), 2 * 1024 * 1024);
      if (digest(source) !== manifest.server_sha256[relative]) refuse();
    }
    return helperPath;
  } catch { refuse(); }
}
