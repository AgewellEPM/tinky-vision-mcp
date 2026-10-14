import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { portalState } from '../stream-vision.mjs';

const execute = promisify(execFile);
const run = async (command, args) => (await execute(command, args, { timeout: 10000, maxBuffer: 1024 * 1024 })).stdout;

// TinkyStream is an existing shared LaunchAgent, not a new capture loop per
// MCP connection. Reuse it, start it if absent, never restart/stop a borrowed
// producer, and enforce Luke's capture limits before launching anything.
export class StreamService {
  constructor({ invoke = run, home = homedir(), uid = process.getuid(), observe = portalState } = {}) {
    this.invoke = invoke;
    this.plist = join(home, 'Library/LaunchAgents/com.tinky.tinkystream.plist');
    this.executable = join(home, 'Applications/TinkyStream.app/Contents/MacOS/TinkyStream');
    this.label = `gui/${uid}/com.tinky.tinkystream`;
    this.observe = observe;
  }

  async configuration() {
    const config = JSON.parse(await this.invoke('/usr/bin/plutil', ['-convert', 'json', '-o', '-', this.plist]));
    const env = config.EnvironmentVariables || {};
    const fps = Number(env.TINKY_STREAM_FPS);
    const seeThroughFPS = Number(env.TINKY_STREAM_SEETHROUGH_FPS);
    const ring = Number(env.TINKY_STREAM_RING);
    if (config.Label !== 'com.tinky.tinkystream' || config.ProgramArguments?.[0] !== this.executable ||
        !Number.isFinite(fps) || fps <= 0 || fps > 1 ||
        !Number.isFinite(seeThroughFPS) || seeThroughFPS <= 0 || seeThroughFPS > 1 || ring !== 300) {
      throw new Error('TinkyStream LaunchAgent must use its installed app, capture ≤1 FPS per lane and a 300-frame ring');
    }
    return { fps, seeThroughFPS, ring, displayName: env.TINKY_STREAM_DISPLAY_NAME || null };
  }

  async inspect() {
    try {
      const text = await this.invoke('/bin/launchctl', ['print', this.label]);
      const pid = Number(text.match(/^\s*pid = (\d+)$/m)?.[1]);
      return { loaded: true, running: /^\s*state = running$/m.test(text) && pid > 0, pid: pid || null };
    } catch (error) {
      // A transport/permission error must not be mistaken for an unloaded job.
      if (!/Could not find service|service not found/i.test(`${error.stderr || ''} ${error.message}`)) throw error;
      return { loaded: false, running: false, pid: null };
    }
  }

  async ensureRunning() {
    if (this.pending) return this.pending;
    this.pending = this.ensureOnce();
    try { return await this.pending; } finally { this.pending = null; }
  }

  async ensureOnce() {
    const limits = await this.configuration();
    let state = await this.inspect();
    let started = false;
    if (!state.running) {
      if (!state.loaded) {
        try {
          await this.invoke('/bin/launchctl', ['bootstrap', this.label.split('/').slice(0, 2).join('/'), this.plist]);
          started = true;
        } catch (error) {
          // Another client may have loaded the same shared job first.
          if (!(await this.inspect()).loaded) throw error;
        }
      } else {
        // Deliberately no -k: never kill a healthy existing capture process.
        await this.invoke('/bin/launchctl', ['kickstart', this.label]);
        started = true;
      }
      for (let attempt = 0; attempt < 20; attempt++) {
        state = await this.inspect();
        if (state.running) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!state.running) throw new Error('TinkyStream did not start; inspect its LaunchAgent log');
    }
    const observation = this.observe();
    return { ...state, ...limits, started, shared: true,
      captureFresh: observation.lanes.full.fresh,
      lanes: observation.lanes, observedAt: observation.observedAt,
      source: 'physical-display',
      note: 'The isolated app uses its session frame/history. TinkyStream also supplies the physical desktop lanes.' };
  }
}
