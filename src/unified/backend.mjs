import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// One local child, owned by this connection. The native session manager keeps
// its existing serialization, capture, authorization and recording behavior.
export class Backend {
  constructor(name, command, args = [], env = {}) {
    this.name = name;
    this.client = new Client({ name: 'isolated-vision-system', version: '1.0.0' });
    this.transport = new StdioClientTransport({ command, args, env, stderr: 'inherit' });
    this.ready = false;
    this.client.onclose = () => { this.ready = false; };
  }

  async connect() {
    try {
      await this.client.connect(this.transport, { timeout: 15000 });
      this.tools = (await this.client.listTools()).tools;
      this.info = this.client.getServerVersion();
      this.ready = true;
    } catch (error) {
      await this.client.close();
      throw new Error(`${this.name} startup failed: ${error.message}`);
    }
  }

  call(name, args = {}) {
    if (!this.ready) throw new Error(`${this.name} backend is disconnected`);
    return this.client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  }

  async close({ stopSessions = false } = {}) {
    try {
      if (stopSessions && this.ready) {
        const sessions = value(await this.call('list_sessions'));
        for (const session of sessions) {
          await this.call('stop_session', { sessionId: session.sessionId });
        }
      }
    } finally {
      this.ready = false;
      await this.client.close();
    }
  }
}

export function value(result) {
  if (result.isError) throw new Error(result.content?.find(c => c.type === 'text')?.text || 'Backend tool failed');
  const block = result.content?.find(c => c.type === 'text');
  if (!block) throw new Error('Backend returned no JSON text');
  return JSON.parse(block.text);
}

export function jsonResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
