#!/usr/bin/env node
// Build only from an immutable copied source snapshot into a NEW staging root.
// This script never launches a helper, alters TCC, deploys, or restarts MCP.
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, lstatSync, readlinkSync, realpathSync, readFileSync, readdirSync,
  mkdirSync, openSync, closeSync, writeSync, fsyncSync, constants } from 'node:fs';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeScopedAXManifest, SCOPED_AX_PRODUCT, SCOPED_AX_SERVER_FILES } from '../src/scoped-ax-helper.mjs';

const SOURCE_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const sha = data => createHash('sha256').update(data).digest('hex');
function require(value, message) { if (!value) throw new Error(message); }

export function snapshotInputs(root) {
  const names = [...SCOPED_AX_SERVER_FILES, 'package.json', 'package-lock.json',
    'swift-helper/Package.swift', 'scripts/stage-scoped-helper.mjs'];
  function swiftFiles(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      require(!entry.isSymbolicLink(), 'A Swift source entry is a symlink.');
      const path = join(directory, entry.name);
      if (entry.isDirectory()) swiftFiles(path);
      else if (entry.isFile() && entry.name.endsWith('.swift')) names.push(relative(root, path));
    }
  }
  swiftFiles(join(root, 'swift-helper', 'Sources'));
  // SwiftPM validates test-target source paths even when building one product.
  swiftFiles(join(root, 'swift-helper', 'Tests'));
  const sources = new Map();
  for (const name of names.sort()) {
    const path = join(root, name), info = lstatSync(path);
    require(info.isFile() && !info.isSymbolicLink() && info.nlink === 1
      && (info.mode & 0o022) === 0 && info.size <= 2 * 1024 * 1024,
    'A staged source is not a bounded regular file.');
    sources.set(name, readFileSync(path));
  }
  return sources;
}

export function legacyFingerprint(root) {
  const result = {};
  for (const name of ['tinky-os', 'tinky-os-ax']) {
    const path = join(root, 'bin', name);
    let info;
    try { info = lstatSync(path); }
    catch (error) { if (error.code === 'ENOENT') { result[name] = null; continue; } throw error; }
    require(info.isFile() || info.isSymbolicLink(), 'Legacy helper has an unsupported file type.');
    const actual = realpathSync(path), target = lstatSync(actual);
    require(target.isFile() && target.size <= 32 * 1024 * 1024, 'Legacy helper comparison exceeds its bound.');
    result[name] = { device: info.dev, inode: info.ino, mode: info.mode,
      link: info.isSymbolicLink() ? readlinkSync(path) : null, target: actual,
      target_device: target.dev, target_inode: target.ino, sha256: sha(readFileSync(actual)) };
  }
  return result;
}

function writeExclusive(path, bytes, mode) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      require(count > 0, 'Staging write made no progress.');
      offset += count;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function buildCommand(args, run, logPath) {
  const result = run('/usr/bin/xcrun', ['swift', ...args], {
    encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
  });
  writeExclusive(logPath, Buffer.from((result.stdout || '') + (result.stderr || '')), 0o600);
  require(!result.error && result.status === 0 && !result.signal,
    'Scoped helper build failed; its staging directory is retained for inspection.');
  return result.stdout || '';
}

export function stageScopedHelper({ root = SOURCE_ROOT, output, run = spawnSync } = {}) {
  root = realpathSync(root);
  require(typeof output === 'string' && isAbsolute(output), 'An absolute NEW staging directory is required.');
  output = resolve(output);
  require(realpathSync(dirname(output)) === dirname(output) && !existsSync(output),
    'Staging parent must be physical and destination must not already exist.');
  const before = legacyFingerprint(root), sources = snapshotInputs(root);
  mkdirSync(output, { mode: 0o700 });
  for (const [name, bytes] of sources) writeExclusive(join(output, name), bytes, 0o600);
  const packagePath = join(output, 'swift-helper'), scratch = join(output, '.build');
  const common = ['build', '--package-path', packagePath, '--scratch-path', scratch,
    '--configuration', 'release', '--jobs', '2'];
  buildCommand([...common, '--product', SCOPED_AX_PRODUCT], run, join(output, 'build.log'));
  const bin = buildCommand([...common, '--show-bin-path'], run, join(output, 'build-path.log')).trim();
  require(isAbsolute(bin) && realpathSync(bin).startsWith(scratch + '/'), 'Build output escaped its staging root.');
  const helper = join(bin, SCOPED_AX_PRODUCT), info = lstatSync(helper);
  require(info.isFile() && !info.isSymbolicLink() && info.nlink === 1
    && info.size > 0 && info.size <= 32 * 1024 * 1024, 'Build did not produce a bounded dedicated helper.');
  const current = snapshotInputs(root);
  require(current.size === sources.size && [...sources].every(([name, bytes]) => current.get(name)?.equals(bytes)),
    'Source changed during staging; do not deploy this candidate.');
  require(JSON.stringify(legacyFingerprint(root)) === JSON.stringify(before),
    'Legacy helper changed during staging; do not deploy this candidate.');
  const binary = readFileSync(helper);
  const serverHashes = Object.fromEntries(SCOPED_AX_SERVER_FILES.map(name => [name, sha(sources.get(name))]));
  const buildInputs = Object.fromEntries([...sources].map(([name, bytes]) => [name, sha(bytes)]));
  const manifest = makeScopedAXManifest(binary, serverHashes, buildInputs);
  const destination = join(output, 'bin', SCOPED_AX_PRODUCT);
  writeExclusive(destination, binary, 0o755);
  writeExclusive(destination + '.manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), 0o600);
  const plan = { schema_version: 1, staged_only: true, installed_copy_modified: false,
    helper_executed: false, native_consent_verified: false, accepted: false,
    source_root: root, staged_root: output, helper: destination,
    manifest: destination + '.manifest.json', legacy_before: before,
    next_steps: [
      'Review source and helper digests; run the dedicated helper --protocol-info separately (no AX or AppKit initialization).',
      'For the home checkout, copy only the dedicated helper and manifest after source hashes still match; do not replace either legacy helper.',
      'For an older installed server, review and merge only scoped imports, selection, tool definitions, dispatch and shutdown. Preserve its other code and legacy helper symlink targets.',
      'After an older-server merge is reviewed, bind the manifest to the exact merged runtime modules; never copy the whole newer server over unrelated installed changes.',
      'Reconnect the configured MCP client and check its tool catalog. Do not retry a denied consent request or treat staging as permission to enroll or press.',
    ] };
  writeExclusive(join(output, 'DEPLOYMENT.json'), Buffer.from(JSON.stringify(plan, null, 2) + '\n'), 0o600);
  return plan;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    require(args.length === 0 || (args.length === 2 && args[0] === '--output'), 'Usage: npm run build:scoped-helper -- [--output /new/staging/directory]');
    const parent = join(SOURCE_ROOT, '.scoped-ax-staging');
    if (args.length === 0) mkdirSync(parent, { recursive: true, mode: 0o700 });
    const output = args.length ? args[1] : join(parent, randomUUID());
    const plan = stageScopedHelper({ output });
    console.log(JSON.stringify({ staged_only: true, helper: plan.helper, manifest: plan.manifest,
      deployment_plan: join(output, 'DEPLOYMENT.json'), helper_executed: false }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
