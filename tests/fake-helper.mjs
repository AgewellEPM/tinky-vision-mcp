#!/usr/bin/env node
// Fake tinky-os helper used by the test suite. Reads the subcommand
// from argv and emits canned JSON to stdout. Behavior is driven by
// env vars so each test can shape what the "OS" reports:
//
//   TINKY_FAKE_FOCUSED_BUNDLE = bundle ID for `focused-window`
//   TINKY_FAKE_AX             = "true" | "false" for `ax-check`
//   TINKY_FAKE_FIND_TEXT_JSON = literal JSON to return for `find-text`
//   TINKY_FAKE_TARGET_BUNDLE  = bundle ID a `window-info` lookup resolves to
//                               (the CONTROLLER target's owning app). Default
//                               com.apple.Safari (benign).
//   TINKY_FAKE_TARGET_MISSING = "1" → `window-info` reports the window gone
//
// All write subcommands (click/type/key) succeed silently — they only
// matter for verifying that guardedWrite() decided to call us at all.

const sub = process.argv[2] || 'help';
const env = process.env;

function out(o) { process.stdout.write(JSON.stringify(o) + '\n'); }

switch (sub) {
  case 'focused-window':
    out({
      ok: true,
      focused: env.TINKY_FAKE_FOCUSED_BUNDLE
        ? { bundleID: env.TINKY_FAKE_FOCUSED_BUNDLE, name: 'FakeApp', pid: 1, window: {} }
        : null,
    });
    break;
  case 'ax-check':
    out({ ok: true, accessibility: env.TINKY_FAKE_AX === 'true' });
    // Real binary exits 1 when permission missing; mirror that so the
    // server's try/catch path is exercised.
    process.exit(env.TINKY_FAKE_AX === 'true' ? 0 : 1);
  case 'apps':
    out({ ok: true, apps: [{ name: 'Fake', bundleID: 'com.fake.app', pid: 1, active: true }] });
    break;
  case 'screenshot':
    out({ ok: true, path: '/tmp/fake-shot.png', bytes: 0 });
    break;
  case 'find-window':
    out({ ok: true, windows: [] });
    break;
  case 'find-text':
    if (env.TINKY_FAKE_FIND_TEXT_JSON) {
      process.stdout.write(env.TINKY_FAKE_FIND_TEXT_JSON + '\n');
    } else {
      out({ ok: true, image: {}, query: '', matches: [], match_count: 0 });
    }
    break;
  case 'window-info':
    if (env.TINKY_FAKE_TARGET_MISSING === '1') {
      out({ ok: false, error: 'no on-screen window', window: 0 });
    } else {
      out({
        ok: true,
        window: 42,
        pid: 4242,
        bundleID: env.TINKY_FAKE_TARGET_BUNDLE ?? 'com.apple.Safari',
        owner: 'FakeTarget',
        title: 'Fake Target Window',
        bounds: { X: 0, Y: 0, Width: 100, Height: 100 },
      });
    }
    break;
  case 'click':
  case 'type':
  case 'key':
  case 'control-click':
  case 'move-window':
  case 'raise-window':
    out({ ok: true, fake: true, sub });
    break;
  default:
    out({ ok: false, error: 'unknown fake subcmd: ' + sub });
    process.exit(1);
}
