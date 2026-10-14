import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema,
  ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Backend, jsonResult, value } from './backend.mjs';
import { StreamService } from './stream-service.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const sessionProperty = { type: 'string', minLength: 1,
  description: 'IsolatedTester session ID. Targets that app and uses window-image coordinates; omit only for deliberate host-desktop operations.' };
const scopedNames = new Set(['os_screenshot', 'os_click', 'os_type', 'os_key', 'vision_find_text']);

export const EXTRA_TOOLS = [
  { name: 'observe_session', description: 'Observe an isolated app with one call: fresh IsolatedTester frame, TinkyVision local OCR of that exact frame, recording status and TinkyStream health. No cloud provider.',
    inputSchema: { type: 'object', properties: { sessionId: sessionProperty }, required: ['sessionId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'stream_status', description: 'Check the shared local TinkyStream producer, ≤1 FPS/300-frame limits and independent frame freshness. The unified MCP ensures it runs automatically; isolated app footage remains session-scoped.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
];

export function combinedTools(isolated, vision) {
  const tools = [...isolated, ...vision.map(tool => {
    if (!scopedNames.has(tool.name)) return tool;
    const inputSchema = { ...tool.inputSchema,
      properties: { ...tool.inputSchema.properties, sessionId: sessionProperty } };
    // Session input is already authorized through the existing native tools.
    // Unscoped host writes still require Tinky's target/description and gates.
    if (['os_click', 'os_type', 'os_key'].includes(tool.name)) {
      const required = inputSchema.required || [];
      inputSchema.required = required.filter(key => !['target', 'description'].includes(key));
      inputSchema.anyOf = [{ required: ['sessionId'] }, { required: ['target', 'description'] }];
    }
    return { ...tool, inputSchema,
      description: `${tool.description} In this combined MCP, pass sessionId for the isolated app; otherwise the original host behavior and consent gates apply.` };
  }), ...EXTRA_TOOLS];
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('Combined MCP tool names collide');
  return tools;
}

export class UnifiedSystem {
  constructor(isolated, vision, stream, { readOnly = false } = {}) {
    this.isolated = isolated; this.vision = vision; this.stream = stream;
    this.readOnly = readOnly;
    this.tools = combinedTools(isolated.tools, vision.tools);
    this.routes = new Map([...isolated.tools.map(tool => [tool.name, isolated]),
      ...vision.tools.map(tool => [tool.name, vision])]);
  }

  async call(name, args = {}) {
    const tool = this.tools.find(tool => tool.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    if (this.readOnly && tool.annotations?.readOnlyHint !== true) throw new Error('Unified MCP is read-only');
    if (!this.isolated.ready || !this.vision.ready) throw new Error('A combined MCP backend disconnected; reconnect the server');
    const stream = await this.stream.ensureRunning();
    if (name === 'stream_status') return jsonResult(stream);
    if (name === 'observe_session') {
      const sessionId = this.sessionId(args);
      const frame = value(await this.isolated.call('session_frame', { sessionId }));
      const vision = value(await this.vision.call('vision_find_text', { inPath: frame.path }));
      const recording = value(await this.isolated.call('frame_history', { sessionId, limit: 1 }));
      return jsonResult({ sessionId, frame, vision, recording, tinkyStream: stream,
        coordinateSpace: 'isolated-window-image' });
    }
    if (scopedNames.has(name) && Object.hasOwn(args, 'sessionId')) {
      return this.callScoped(name, args);
    }
    const result = await this.routes.get(name).call(name, args);
    if (!result.isError && name === 'setup_status') {
      return jsonResult({ ...value(result), unified: true, toolCount: this.tools.length,
        components: { isolatedTester: { ...this.isolated.info, pid: this.isolated.transport.pid },
          tinkyVision: { ...this.vision.info, pid: this.vision.transport.pid }, tinkyStream: stream } });
    }
    if (!result.isError && name === 'create_session') {
      return jsonResult({ ...value(result), tinkyVision: { connected: true }, tinkyStream: stream });
    }
    return result;
  }

  sessionId(args) {
    if (typeof args.sessionId !== 'string' || !args.sessionId.trim()) throw new Error('A nonempty sessionId is required; refusing a host-desktop fallback');
    return args.sessionId;
  }

  async callScoped(name, args) {
    const sessionId = this.sessionId(args);
    switch (name) {
      case 'os_screenshot':
        if (args.bundleId !== undefined || args.outPath !== undefined) throw new Error('Session screenshots use the session-owned path; omit bundleId and outPath');
        return this.isolated.call('session_frame', { sessionId });
      case 'vision_find_text': {
        if (args.inPath !== undefined) throw new Error('Choose sessionId or inPath, not both');
        const frame = value(await this.isolated.call('session_frame', { sessionId }));
        const result = await this.vision.call(name, { inPath: frame.path, ...(args.query === undefined ? {} : { query: args.query }) });
        if (result.isError) return result;
        return jsonResult({ ...value(result), sessionId, frame, coordinateSpace: 'isolated-window-image' });
      }
      case 'os_click':
        if (!Number.isFinite(args.x) || !Number.isFinite(args.y)) throw new Error('Click coordinates must be finite numbers');
        if (args.double) throw new Error('The native MCP does not expose double-click; refusing to substitute a host click');
        return this.isolated.call('click', { sessionId, x: args.x, y: args.y });
      case 'os_type':
        if (typeof args.text !== 'string') throw new Error('text must be a string');
        return this.isolated.call('type_text', { sessionId, text: args.text });
      case 'os_key': {
        if (typeof args.key !== 'string' || !args.key) throw new Error('key must be a nonempty string');
        const modifiers = [['cmd', 'cmd'], ['shift', 'shift'], ['opt', 'option'], ['ctrl', 'ctrl']]
          .filter(([key]) => args[key] === true).map(([, modifier]) => modifier);
        return this.isolated.call('key_press', { sessionId, key: args.key, modifiers });
      }
      default: throw new Error('Unsupported session tool');
    }
  }
}

function environment(prefixes) {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['TMPDIR', 'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM'].includes(key) || prefixes.some(prefix => key.startsWith(prefix))));
}

export async function startSystem() {
  const readOnly = process.argv.includes('--read-only');
  const isolated = new Backend('IsolatedTester', process.env.TINKY_ISOLATED_BIN || join(homedir(), '.local/bin/isolated-mcp'), [],
    environment(['IST_', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']));
  const vision = new Backend('TinkyVision', process.execPath,
    [resolve(directory, '../server.mjs'), ...(readOnly ? ['--read-only'] : [])], environment(['TINKY_']));
  const stream = new StreamService();
  let server, closing;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      // Stop and finalize only THIS connection's native sessions before EOF.
      try { await isolated.close({ stopSessions: true }); }
      finally { await vision.close(); }
    })();
    return closing;
  };
  try {
    // Startup is one operation to the MCP client. No backend is advertised as
    // available unless both initialized and the managed stream is running.
    const results = await Promise.allSettled([isolated.connect(), vision.connect(), stream.ensureRunning()]);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    const system = new UnifiedSystem(isolated, vision, stream, { readOnly });
    server = new Server({ name: 'isolated-tester', version: '1.0.0-unified' },
      { capabilities: { tools: {}, resources: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: system.tools }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      try { return await system.call(request.params.name, request.params.arguments || {}); }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
    });
    server.setRequestHandler(ListResourcesRequestSchema, () => isolated.client.listResources());
    server.setRequestHandler(ReadResourceRequestSchema, request => isolated.client.readResource(request.params));
    server.onclose = () => { close().catch(error => console.error(`[isolated-vision-system] cleanup: ${error.message}`)); };
    const signal = async () => {
      try { await close(); await server.close(); }
      catch (error) { console.error(`[isolated-vision-system] shutdown: ${error.message}`); process.exitCode = 1; }
    };
    process.once('SIGTERM', signal);
    process.once('SIGINT', signal);
    await server.connect(new StdioServerTransport());
    console.error(`[isolated-vision-system] ready: ${system.tools.length} tools, shared TinkyStream PID ${results[2].value.pid}`);
  } catch (error) {
    await close();
    throw error;
  }
}
