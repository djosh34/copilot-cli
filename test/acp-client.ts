// The ACP client side of the tests: the official ACP SDK client connected to an agent process, a check of every raw
// message against the ACP v1 JSON schema, and a helper that runs one prompt.
import * as acp from '@agentclientprotocol/sdk';
import { Ajv2020 } from 'ajv/dist/2020.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { killGroup, root, type Scratch } from './common.ts';
import type { Script, startFakeLlm } from './fake-llm.ts';

// Validates each raw message's params or result against the schema type for its method and direction.
const schema = JSON.parse(readFileSync(join(root, 'node_modules/@agentclientprotocol/sdk/schema/v1/schema.json'), 'utf8'));
const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(schema, 'acp');
function typeFor(method: string, side: string, suffix: string): string {
  const names = Object.keys(schema.$defs).filter(k => k.endsWith(suffix) && schema.$defs[k]['x-method'] === method && schema.$defs[k]['x-side'] === side);
  assert.equal(names.length, 1, `one schema type for ${side} ${method} ${suffix}`);
  return names[0];
}
export function validate(name: string, value: unknown) {
  const check = ajv.getSchema(`acp#/$defs/${name}`)!;
  assert.ok(check(value), `${name} ${JSON.stringify(value)}: ${ajv.errorsText(check.errors)}`);
}
// The schema check can fail: a made-up stop reason and a text chunk without text are refused.
assert.throws(() => validate('PromptResponse', { stopReason: 'bogus' }));
assert.throws(() => validate('SessionNotification', { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text' } } }));
type Wire = { from: 'client' | 'agent'; message: any }[];
export function validateWire(wire: Wire) {
  const pending = new Map<string, string>();
  for (const { from, message: m } of wire) {
    const to = from === 'client' ? 'agent' : 'client';
    assert.equal(m.jsonrpc, '2.0');
    if ('method' in m) {
      const kind = 'id' in m ? 'Request' : 'Notification';
      if ('id' in m) pending.set(`${from}:${m.id}`, typeFor(m.method, to, 'Response'));
      validate(typeFor(m.method, to, kind), m.params);
    } else {
      const name = pending.get(`${to}:${m.id}`);
      assert.ok(name, `a response to a request: ${JSON.stringify(m)}`);
      pending.delete(`${to}:${m.id}`);
      if ('error' in m) assert.ok(Number.isInteger(m.error.code) && typeof m.error.message === 'string', JSON.stringify(m));
      else validate(name, m.result);
    }
  }
  assert.deepEqual([...pending.keys()], [], 'every request was answered');
}

// Starts an ACP agent process and connects the official client to it, recording every raw message.
export function connect(command: string, args: string[], d: Scratch, env: Record<string, string>) {
  const child = spawn(command, args, { cwd: d.project, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', s => (stderr += s));
  const wire: Wire = [];
  const updates: acp.SessionNotification[] = [];
  let permissionAsks = 0;
  const base = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
  const record = (from: 'client' | 'agent') => new TransformStream({ transform(message, out) { wire.push({ from, message }); out.enqueue(message); } });
  const toAgent = record('client');
  toAgent.readable.pipeTo(base.writable).catch(err => (stderr += `\nwrite to agent failed: ${err}`));
  const connection = acp.client({ name: 'acp-test' })
    .onRequest('session/request_permission', () => {
      permissionAsks++;
      return { outcome: { outcome: 'cancelled' as const } };
    })
    .onNotification('session/update', ({ params }) => { updates.push(params); })
    .connect({ writable: toAgent.writable, readable: base.readable.pipeThrough(record('agent')) });
  const agent = connection.agent;
  return {
    agent, wire, updates,
    pid: child.pid,
    permissionAsks: () => permissionAsks,
    stderr: () => stderr,
    text: (sessionId: string) => updates.filter(u => u.sessionId === sessionId && u.update.sessionUpdate === 'agent_message_chunk')
      .map(u => (u.update as { content: { text: string } }).content.text),
    initialize: () => agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: 'acp-test', version: '1' } }),
    newSession: (mcpServers: acp.McpServer[] = []) => agent.request('session/new', { cwd: d.project, mcpServers }).then(r => r.sessionId),
    prompt: (sessionId: string, prompt: acp.ContentBlock[] | string) => agent.request('session/prompt', {
      sessionId, prompt: typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt,
    }),
    close: async () => {
      connection.close();
      if (child.pid) await killGroup(child.pid);
    },
  };
}
export type Connection = ReturnType<typeof connect>;

export const adapter = (d: Scratch, env: Record<string, string>) => connect(join(root, 'bin/copilot-min'), ['--acp', '--sync-session', 'off'], d, env);

// Runs one prompt and checks it ended normally, its streamed text, and the minimal requests it made.
export async function turn(c: Connection, llm: Awaited<ReturnType<typeof startFakeLlm>>, sessionId: string, prompt: acp.ContentBlock[] | string, text: string) {
  const from = llm.requests.length;
  const chunks = c.text(sessionId).length;
  const result = await c.prompt(sessionId, prompt);
  assert.equal(result.stopReason, 'end_turn', c.stderr());
  const streamed = c.text(sessionId).slice(chunks);
  assert.equal(streamed.join(''), text, 'streamed text, not empty and not doubled');
  assert.equal(streamed.length, 2, 'in the two pieces the model sent');
  return llm.requests.slice(from);
}

export const oneSubagent = (d: Scratch): Script => ({
  parent: [
    { tool: 'task', args: { name: 'reader', agent_type: 'gp', description: 'Read hello.txt', prompt: 'Read hello.txt' } },
    { text: 'parent-done' },
  ],
  subagent: [{ tool: 'view', args: { path: join(d.project, 'hello.txt') } }, { text: 'subagent-done' }],
});
