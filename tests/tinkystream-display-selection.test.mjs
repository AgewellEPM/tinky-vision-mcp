import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  resolve(here, '..', 'swift-helper', 'Sources', 'TinkyOS', 'main.swift'),
  'utf8',
);

test('TinkyStream requires an explicit named physical display', () => {
  assert.match(source, /stream requires --display-name <physical display name>/);
  assert.match(source, /TINKY_STREAM_DISPLAY_NAME/);
  assert.match(source, /selectStreamDisplay\(content\.displays,/);
  assert.match(source, /candidate\.compare\(wanted, options: \[\.caseInsensitive, \.diacriticInsensitive\]\)/);

  const runStream = source.split('func runStream(', 2)[1].split('func cmdStream', 1)[0];
  assert.equal(runStream.includes('content.displays.first'), false,
    'capture must not follow the synthetic main display');
  assert.equal(runStream.includes('fresh.displays.first'), false,
    'see-through refresh must stay pinned to the physical display');
});

test('both stream lanes share the pinned display and sRGB output contract', () => {
  assert.match(source, /config\.colorSpaceName = CGColorSpace\.sRGB/);

  const starts = [...source.matchAll(/await runStream\([\s\S]*?hold: hold, release: release\)/g)]
    .map((match) => match[0]);
  assert.equal(starts.length, 2, 'expected full and see-through stream starts');
  for (const start of starts) {
    assert.match(start, /displayName: displayName/);
  }
  assert.match(source, /"colorSpace": "sRGB"/);
  assert.match(source, /"displayID": display\.displayID/);
});

test('stopped or wedged stream lanes recover without racing OS teardown', () => {
  const sinkAndWatchdog = source
    .split('final class StreamSink', 2)[1]
    .split('// Build the capture filter', 1)[0];
  const sink = sinkAndWatchdog.split('\n}\n\nfunc streamSessionIsLocked', 1)[0];
  const delegateStop = sink.split('didStopWithError', 2)[1];
  assert.match(delegateStop, /stopGeneration \+= 1/);
  assert.match(delegateStop, /recovering/);
  assert.equal(delegateStop.includes('exit(4)'), false,
    'the ScreenCaptureKit callback must not immediately relaunch into OS teardown');

  const runStream = source.split('func runStream(', 2)[1].split('func cmdStream', 1)[0];
  assert.match(runStream, /currentStopGeneration\(\) > recoveringGeneration/);
  assert.match(runStream, /Task\.sleep\(nanoseconds: 2_000_000_000\)/);
  assert.match(runStream, /release\(stream\)/);

  const watchdog = source
    .split('func startStreamRecoveryWatchdog', 2)[1]
    .split('// Build the capture filter', 1)[0];
  assert.match(watchdog, /timeoutSeconds: TimeInterval = 45\.0/);
  assert.match(watchdog, /streamSessionIsLocked\(\)/);
  assert.match(watchdog, /fatalRecoveryRestart/);
  assert.match(watchdog, /exit\(4\)/);
  assert.match(source, /startStreamRecoveryWatchdog\(recoverySinks\)/);
});
