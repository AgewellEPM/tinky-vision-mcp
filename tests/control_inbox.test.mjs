// Integration tests for the `tinky-os control-inbox` grant-holder daemon.
//
// The daemon is the fix for the launchd-console Accessibility gap: it runs
// inside the grant-holding TinkyStream.app and executes control ops the console
// drops as <id>.req.json, writing <id>.res.json. These tests pin the file
// PROTOCOL + error contract — the parts that are deterministic without a live
// AX grant or an on-screen window (so they pass in CI). The AX-success path is
// covered by the live E2E via the console, not here.
//
// Per the multi-site rule: every request/error shape gets its own assertion so
// a regression names WHICH path broke.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "swift-helper", ".build", "release", "tinky-os");

// Drop a request atomically (write .tmp then rename) so the daemon never reads a
// half-written file — the same discipline the console uses.
function dropRequest(dir, id, obj) {
  const tmp = join(dir, `.${id}.req.json.tmp`);
  writeFileSync(tmp, JSON.stringify(obj));
  renameSync(tmp, join(dir, `${id}.req.json`));
}

async function awaitResult(dir, id, timeoutMs = 4000) {
  const resPath = join(dir, `${id}.res.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(resPath)) {
      return JSON.parse(readFileSync(resPath, "utf8"));
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${id}.res.json`);
}

// Each case: [label, request, assertion-on-result]. All are ok:false paths that
// do NOT depend on an AX grant or a real window, so they are CI-deterministic.
const CASES = [
  ["missing windowID", { op: "click", x: 1, y: 1 },
    (r) => assert.match(r.error, /valid windowID is required/)],
  ["zero windowID", { op: "click", windowID: 0, x: 1, y: 1 },
    (r) => assert.match(r.error, /valid windowID is required/)],
  ["nonexistent window", { op: "click", windowID: 999999999, x: 1, y: 1 },
    // no on-screen window OR ax-grant-missing (CI has no grant) — both ok:false.
    (r) => assert.match(r.error, /no on-screen window|Accessibility permission missing/)],
  ["unsupported op", { op: "frobnicate", windowID: 999999999 },
    (r) => assert.match(r.error, /unsupported control op|Accessibility permission missing/)],
];

test("control-inbox honors the request/result protocol for every error path", async (t) => {
  if (!existsSync(BIN)) {
    t.skip(`binary not built at ${BIN} (run: swift build -c release)`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "tinky-inbox-"));
  const daemon = spawn(BIN, ["control-inbox", "--dir", dir, "--poll", "0.03"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    // Every error path, each with a per-case assertion + protocol invariants.
    for (const [label, req, check] of CASES) {
      const id = `t-${label.replace(/\W+/g, "-")}`;
      dropRequest(dir, id, req);
      const result = await awaitResult(dir, id);
      assert.equal(result.ok, false, `${label}: expected ok=false`);
      assert.equal(result.id, id, `${label}: result must echo its id`);
      check(result);
      // Protocol invariant: the request file is consumed once serviced.
      assert.ok(
        !existsSync(join(dir, `${id}.req.json`)),
        `${label}: request file must be deleted after servicing`,
      );
    }
  } finally {
    daemon.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control-inbox tolerates a malformed (non-JSON) request", async (t) => {
  if (!existsSync(BIN)) {
    t.skip("binary not built");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "tinky-inbox-bad-"));
  const daemon = spawn(BIN, ["control-inbox", "--dir", dir, "--poll", "0.03"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    // Write garbage atomically as a .req.json — daemon must not crash, and must
    // still emit an ok:false result so the console isn't left hanging.
    const id = "t-garbage";
    const tmp = join(dir, `.${id}.req.json.tmp`);
    writeFileSync(tmp, "{not valid json at all");
    renameSync(tmp, join(dir, `${id}.req.json`));
    const result = await awaitResult(dir, id);
    assert.equal(result.ok, false);
    assert.match(result.error, /unreadable or malformed request/);
    assert.ok(!existsSync(join(dir, `${id}.req.json`)), "malformed request must be consumed");
  } finally {
    daemon.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
