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

test('TinkyStream seals timestamped five-minute H.264 MP4 segments', () => {
  const archive = source
    .split('final class StreamArchiveWriter', 2)[1]
    .split('final class StreamSink', 1)[0];

  assert.match(archive, /AVAssetWriter\(outputURL: partial, fileType: \.mp4\)/);
  assert.match(archive, /AVVideoCodecType\.h264/);
  assert.match(archive, /candidate\.startSession\(atSourceTime: \.zero\)/);
  assert.match(archive, /writer\.finishWriting/);
  assert.match(archive, /nominalDurationSeconds/);
  assert.equal(archive.includes('removeItem'), false,
    'persistent MP4 history must never silently prune itself');

  assert.match(source, /archive-segment-seconds\"] \?\? "300"/);
  assert.match(source, /TINKY_STREAM_ARCHIVE_SEGMENT_SECONDS/);
  assert.match(source, /TINKY_STREAM_ARCHIVE_DIR/);
});

test('archive exhaustion pauses history without disabling the 300-frame recycler', () => {
  const archive = source
    .split('final class StreamArchiveWriter', 2)[1]
    .split('final class StreamSink', 1)[0];
  assert.match(archive, /freeBytes >= minimumFreeBytes/);
  assert.match(archive, /pausedForLowSpace = true/);
  assert.match(archive, /lowSpaceSkippedFrames \+= 1/);

  const sink = source.split('final class StreamSink', 2)[1].split('// Build the capture filter', 1)[0];
  assert.match(sink, /archive\?\.append\(pixelBuffer\)/);
  assert.match(sink, /ringIndex % ring/);
  assert.match(source, /"archive": sink\.archiveStatus\(\)/);
});

test('only the full physical stream is archived', () => {
  const command = source.split('func cmdStream(', 2)[1].split('// MARK: - Approvals refresh', 1)[0];
  assert.match(command, /StreamSink\(dir: dir, ring: ring,[\s\S]*archive: archive\)/);
  assert.match(command, /StreamSink\(dir: dir, ring: 0,[\s\S]*latestName: "seethrough-latest\.jpg"\)/);
  assert.equal(command.match(/archive: archive/g)?.length, 1,
    'the secondary see-through latest frame must not double archive storage');
});
