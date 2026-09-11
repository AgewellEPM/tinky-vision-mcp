// Pure temporary filesystem/build-runner fixtures. These tests never run Swift,
// a native helper, Accessibility, a consent panel, or an MCP/UI process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync,
  symlinkSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scopedAXHelperPath, validateScopedAXHelper, makeScopedAXManifest,
  SCOPED_AX_SERVER_FILES, SCOPED_AX_PRODUCT } from '../src/scoped-ax-helper.mjs';
import { stageScopedHelper, legacyFingerprint } from '../scripts/stage-scoped-helper.mjs';
import { ScopedAXBridge } from '../src/scoped-ax.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const sha = data => createHash('sha256').update(data).digest('hex');
function fixture(body) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tinky-scoped-deployment-')));
  try { return body(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
function put(root, name, data, mode = 0o600) {
  const path = join(root, name);
  mkdirSync(resolve(path, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(path, data, { mode });
  return path;
}
function manifestFixture(root) {
  const hashes = {};
  for (const name of SCOPED_AX_SERVER_FILES) {
    put(root, name, 'fixture source ' + name);
    hashes[name] = sha(readFileSync(join(root, name)));
  }
  const binary = Buffer.from('fixed fixture bytes; never executed');
  const helper = put(root, 'bin/' + SCOPED_AX_PRODUCT, binary, 0o700);
  put(root, 'bin/' + SCOPED_AX_PRODUCT + '.manifest.json', JSON.stringify(makeScopedAXManifest(binary, hashes)));
  return helper;
}

test('scoped default and explicit paths never use legacy preference or override', () => fixture(root => {
  put(root, 'bin/tinky-os', 'legacy');
  put(root, 'bin/tinky-os-ax', 'legacy AX');
  assert.equal(scopedAXHelperPath(root, { TINKY_HELPER_BIN: '/legacy/override' }), join(root, 'bin/' + SCOPED_AX_PRODUCT));
  assert.equal(scopedAXHelperPath(root, { TINKY_HELPER_BIN: '/legacy/override', TINKY_SCOPED_AX_HELPER_BIN: '/explicit/scoped' }), '/explicit/scoped');
  for (const value of ['', './relative', 'bad\0path']) {
    assert.throws(() => scopedAXHelperPath(root, { TINKY_SCOPED_AX_HELPER_BIN: value }));
  }
  assert.throws(() => validateScopedAXHelper(root, scopedAXHelperPath(root, {})));
}));

test('matching helper and runtime manifest passes without launching the binary', () => fixture(root => {
  const helper = manifestFixture(root);
  assert.equal(validateScopedAXHelper(root, helper), helper);
}));

test('ambiguous or authority-claiming manifests cannot qualify a helper', () => {
  for (const change of ['duplicate', 'authority', 'protocol']) fixture(root => {
    const helper = manifestFixture(root), path = helper + '.manifest.json';
    let raw = readFileSync(path, 'utf8');
    if (change === 'duplicate') raw = raw.replace('"accepted":false', '"accepted":true,"accepted":false');
    else if (change === 'authority') raw = raw.replace('"accepted":false', '"accepted":true');
    else raw = raw.replace('tinky.scoped-ax.v1', 'tinky.scoped-ax.v0');
    writeFileSync(path, raw);
    assert.throws(() => validateScopedAXHelper(root, helper));
  });
});

test('a failed fresh-start deployment check never spawns any helper', async () => {
  let spawns = 0, checks = 0;
  const bridge = new ScopedAXBridge({ helperPath: '/fixture/scoped',
    beforeSpawn: () => { checks++; throw new Error('fixture mismatch'); },
    spawnImpl: () => { spawns++; throw new Error('must not spawn'); } });
  const response = await bridge.request('targets', { pid: 123 });
  assert.equal(response.code, 'bridge_helper_unavailable');
  assert.equal(checks, 1);
  assert.equal(spawns, 0);
  await bridge.close();
});

test('changed helper or server fails without falling back to existing legacy bytes', () => {
  for (const file of ['bin/' + SCOPED_AX_PRODUCT, ...SCOPED_AX_SERVER_FILES]) fixture(root => {
    const helper = manifestFixture(root);
    put(root, 'bin/tinky-os-ax', 'unchanged legacy');
    writeFileSync(join(root, file), 'changed');
    assert.throws(() => validateScopedAXHelper(root, helper));
    assert.equal(readFileSync(join(root, 'bin/tinky-os-ax'), 'utf8'), 'unchanged legacy');
  });
});

test('helper links, parent links and writable artifact files fail closed', () => {
  for (const mode of ['leaf', 'parent', 'writable']) fixture(root => {
    const helper = manifestFixture(root);
    if (mode === 'leaf') {
      const bytes = readFileSync(helper); rmSync(helper);
      const other = put(root, 'other-binary', bytes, 0o700); symlinkSync(other, helper);
      assert.throws(() => validateScopedAXHelper(root, helper));
    } else if (mode === 'parent') {
      symlinkSync(join(root, 'bin'), join(root, 'alias'));
      assert.throws(() => validateScopedAXHelper(root, join(root, 'alias', SCOPED_AX_PRODUCT)));
    } else {
      chmodSync(helper, 0o777);
      assert.throws(() => validateScopedAXHelper(root, helper));
    }
  });
});

function buildFixture(root) {
  for (const name of SCOPED_AX_SERVER_FILES) put(root, name, readFileSync(join(REPO, name)));
  for (const name of ['package.json', 'package-lock.json', 'swift-helper/Package.swift', 'scripts/stage-scoped-helper.mjs']) {
    put(root, name, readFileSync(join(REPO, name)));
  }
  put(root, 'swift-helper/Sources/ScopedAX/Fixture.swift', '// fixture source only');
  put(root, 'swift-helper/Tests/ScopedAXTests/Fixture.swift', '// fixture tests only');
  const target = put(root, 'swift-helper/.build/release/tinky-os', 'EXISTING LEGACY TCC IMAGE', 0o700);
  mkdirSync(join(root, 'bin'));
  symlinkSync('../swift-helper/.build/release/tinky-os', join(root, 'bin/tinky-os'));
  symlinkSync('../swift-helper/.build/release/tinky-os', join(root, 'bin/tinky-os-ax'));
  return target;
}

test('staging builds copied sources into isolated scratch and preserves both legacy symlink targets', () => fixture(root => {
  buildFixture(root);
  const before = legacyFingerprint(root), output = join(root, 'new-stage'), calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, '/usr/bin/xcrun');
    assert.equal(args[0], 'swift');
    assert.equal(args[args.indexOf('--package-path') + 1], join(output, 'swift-helper'));
    assert.equal(args[args.indexOf('--scratch-path') + 1], join(output, '.build'));
    const bin = join(output, '.build', 'fixture', 'release');
    if (args.includes('--show-bin-path')) return { status: 0, stdout: bin + '\n' };
    assert.equal(args[args.indexOf('--product') + 1], SCOPED_AX_PRODUCT);
    put(output, '.build/fixture/release/' + SCOPED_AX_PRODUCT, 'FAKE COMPILED PRODUCT', 0o700);
    return { status: 0, stdout: '' };
  };
  const plan = stageScopedHelper({ root, output, run });
  assert.equal(calls.length, 2);
  assert.equal(plan.helper_executed, false);
  assert.equal(plan.installed_copy_modified, false);
  assert.deepEqual(legacyFingerprint(root), before);
  assert.equal(validateScopedAXHelper(output, plan.helper), plan.helper);
  assert.throws(() => stageScopedHelper({ root, output, run }), /destination/);
  assert.equal(calls.length, 2, 'existing stage never builds or overwrites');
}));

test('source drift or failed build leaves an unusable candidate and never overwrites legacy', () => {
  for (const failure of ['drift', 'build']) fixture(root => {
    buildFixture(root);
    const before = legacyFingerprint(root), output = join(root, 'new-stage');
    const run = (_command, args) => {
      if (failure === 'build') return { status: 1, stdout: '' };
      const bin = join(output, '.build', 'fixture', 'release');
      if (args.includes('--show-bin-path')) return { status: 0, stdout: bin + '\n' };
      put(output, '.build/fixture/release/' + SCOPED_AX_PRODUCT, 'FIXTURE', 0o700);
      writeFileSync(join(root, 'src/scoped-ax.mjs'), 'changed during build');
      return { status: 0, stdout: '' };
    };
    assert.throws(() => stageScopedHelper({ root, output, run }));
    assert.deepEqual(legacyFingerprint(root), before);
    assert.equal(existsSync(join(output, 'bin', SCOPED_AX_PRODUCT)), false);
  });
});
