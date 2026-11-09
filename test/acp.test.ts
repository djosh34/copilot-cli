// Drives copilot-min --acp (the ACP adapter) with the official ACP SDK's client, after install.sh in a throwaway
// home, against the fake model. Checks every raw ACP message against the v1 JSON schema, every model request with
// checkMinimal/checkCalls, and the adapter's ACP behaviour. Also checks plain copilot --acp is refused, and that
// install.sh replaces the guard of an earlier install.
import * as acp from '@agentclientprotocol/sdk';
import { Ajv2020 } from 'ajv/dist/2020.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { checkCalls, checkMinimal, copilotEnv, copilotHome, families, install, killGroup, ours, root, scratch, waitFor, type Family, type Scratch } from './common.ts';
import { holdMarker, startFakeLlm, type Script } from './fake-llm.ts';

// Validates each raw message's params or result against the schema type for its method and direction.
const schema = JSON.parse(readFileSync(join(root, 'node_modules/@agentclientprotocol/sdk/schema/v1/schema.json'), 'utf8'));
const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(schema, 'acp');
function typeFor(method: string, side: string, suffix: string): string {
  const names = Object.keys(schema.$defs).filter(k => k.endsWith(suffix) && schema.$defs[k]['x-method'] === method && schema.$defs[k]['x-side'] === side);
  assert.equal(names.length, 1, `one schema type for ${side} ${method} ${suffix}`);
  return names[0];
}
function validate(name: string, value: unknown) {
  const check = ajv.getSchema(`acp#/$defs/${name}`)!;
  assert.ok(check(value), `${name} ${JSON.stringify(value)}: ${ajv.errorsText(check.errors)}`);
}
// The schema check can fail: a made-up stop reason and a text chunk without text are refused.
assert.throws(() => validate('PromptResponse', { stopReason: 'bogus' }));
assert.throws(() => validate('SessionNotification', { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text' } } }));
type Wire = { from: 'client' | 'agent'; message: any }[];
function validateWire(wire: Wire) {
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
function connect(command: string, args: string[], d: Scratch, env: Record<string, string>) {
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
type Connection = ReturnType<typeof connect>;

const adapter = (d: Scratch, env: Record<string, string>) => connect(join(root, 'bin/copilot-min'), ['--acp', '--sync-session', 'off'], d, env);

// Runs one prompt and checks it ended normally, its streamed text, and the minimal requests it made.
async function turn(c: Connection, llm: Awaited<ReturnType<typeof startFakeLlm>>, sessionId: string, prompt: acp.ContentBlock[] | string, text: string) {
  const from = llm.requests.length;
  const chunks = c.text(sessionId).length;
  const result = await c.prompt(sessionId, prompt);
  assert.equal(result.stopReason, 'end_turn', c.stderr());
  const streamed = c.text(sessionId).slice(chunks);
  assert.equal(streamed.join(''), text, 'streamed text, not empty and not doubled');
  assert.equal(streamed.length, 2, 'in the two pieces the model sent');
  return llm.requests.slice(from);
}

const oneSubagent = (d: Scratch): Script => ({
  parent: [
    { tool: 'task', args: { name: 'reader', agent_type: 'gp', description: 'Read hello.txt', prompt: 'Read hello.txt' } },
    { text: 'parent-done' },
  ],
  subagent: [{ tool: 'view', args: { path: join(d.project, 'hello.txt') } }, { text: 'subagent-done' }],
});

// An HTTP MCP server that only counts the requests it gets.
async function mcpProbe() {
  let seen = 0;
  const server = createServer((req, res) => {
    seen++;
    res.writeHead(500).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return { url, seen: () => seen, close: () => server.close() };
}

for (const family of families) {
  test(`copilot-min --acp on ${family.model}`, async () => {
    const d = scratch();
    const llm = await startFakeLlm(oneSubagent(d));
    const mcp = await mcpProbe();
    let c: Connection | undefined;
    try {
      install(d, 'y');
      const skill = join(copilotHome(d), 'skills/hello-skill');
      mkdirSync(skill, { recursive: true });
      writeFileSync(join(skill, 'SKILL.md'), '---\nname: hello-skill\ndescription: Says hello.\n---\nSay hello.\n');
      c = adapter(d, copilotEnv(d, family, llm.url));
      const init = await c.initialize();
      assert.equal(init.protocolVersion, 1);

      // Two sessions in one process, each with a gp subagent that reads the file. The client's MCP server is ignored.
      const a = await c.newSession([{ type: 'http', name: 'probe', url: mcp.url, headers: [] }]);
      checkCalls(await turn(c, llm, a, 'Read hello.txt with a subagent', 'parent-done'), family, 1);
      const b = await c.newSession();
      checkCalls(await turn(c, llm, b, 'Read hello.txt with a subagent', 'parent-done'), family, 1);
      assert.ok(llm.requests.some(r => r.body.tools?.some((t: any) => (t.description ?? t.function?.description ?? '').includes('hello-skill'))), 'skill offered');

      // An embedded text resource and a resource link reach the model.
      llm.script = { parent: [{ text: 'resource-ok' }], subagent: [] };
      let requests = await turn(c, llm, a, [
        { type: 'text', text: 'Use this' },
        { type: 'resource', resource: { uri: 'file:///embedded.txt', mimeType: 'text/plain', text: 'EMBEDDED-MARKER' } },
      ], 'resource-ok');
      assert.ok(requests.some(r => JSON.stringify(r.body).includes('EMBEDDED-MARKER')), 'embedded resource reached the model');
      checkMinimal(requests, family);
      requests = await turn(c, llm, a, [{ type: 'resource_link', uri: 'file:///linked.txt', name: 'linked.txt' }], 'resource-ok');
      assert.ok(requests.some(r => JSON.stringify(r.body).includes('[Resource link: file:///linked.txt]')), 'resource link reached the model');
      checkMinimal(requests, family);

      // AGENTS.md is not sent, and bash output over 8 KB goes to a file.
      writeFileSync(join(d.project, 'AGENTS.md'), 'AGENTS-MD-MARKER\n');
      llm.script = { parent: [{ tool: 'bash', args: { command: 'seq 1 2500', description: 'big' } }, { text: 'big-done' }], subagent: [] };
      requests = await turn(c, llm, await c.newSession(), 'Big output', 'big-done');
      checkMinimal(requests, family);
      assert.doesNotMatch(JSON.stringify(requests), /AGENTS-MD-MARKER/, 'AGENTS.md not sent');
      const output = JSON.stringify(requests.at(-1)?.body.input ?? requests.at(-1)?.body.messages);
      assert.match(output, /Saved to/, 'large output saved to a file');
      assert.doesNotMatch(output, /\b2499\b/, 'large output not inline');

      // Cancel while the model holds its response.
      llm.script = { parent: [{ text: 'never' }], subagent: [] };
      const held = c.prompt(b, `Wait ${holdMarker}`);
      await waitFor('the held model request', () => llm.held() > 0);
      await c.agent.notify('session/cancel', { sessionId: b });
      assert.equal((await held).stopReason, 'cancelled');
      llm.release();

      // Tools: every start has an end; nothing asked the client for permission; the client's MCP server got nothing.
      const starts = c.updates.filter(u => u.update.sessionUpdate === 'tool_call');
      const ends = c.updates.filter(u => u.update.sessionUpdate === 'tool_call_update');
      assert.ok(starts.length >= 5, 'tool starts');
      for (const s of starts) {
        const id = (s.update as acp.ToolCall).toolCallId;
        assert.ok(ends.some(e => e.sessionId === s.sessionId && (e.update as acp.ToolCallUpdate).toolCallId === id && (e.update as acp.ToolCallUpdate).status === 'completed'), `end of ${id}`);
      }
      assert.equal(c.permissionAsks(), 0, 'no session/request_permission');
      assert.equal(mcp.seen(), 0, 'no request to the client MCP server');
      assert.match(c.stderr(), new RegExp(`session ${a}: MCP servers: github-mcp-server disabled`), 'the built-in GitHub MCP server is off');

      // With an agent of your own, task offers gp and that agent.
      mkdirSync(join(copilotHome(d), 'agents'));
      writeFileSync(join(copilotHome(d), 'agents/own.agent.md'), '---\nname: own\ndescription: My own agent.\n---\nBe brief.\n');
      llm.script = { parent: [{ text: 'own-ok' }], subagent: [] };
      checkMinimal(await turn(c, llm, await c.newSession(), 'Hi', 'own-ok'), family, ['gp', 'own']);

      validateWire(c.wire);
    } finally {
      await c?.close();
      llm.close();
      mcp.close();
      rmSync(d.dir, { recursive: true, force: true });
    }
  });
}

const family: Family = families[0];

test('plain copilot --acp is refused with a pointer to copilot-min --acp', async () => {
  const d = scratch();
  const llm = await startFakeLlm({ parent: [{ text: 'should not happen' }], subagent: [] });
  let c: Connection | undefined;
  try {
    install(d, 'y');
    c = connect('copilot', ['--acp', '--sync-session', 'off', '--yolo'], d, copilotEnv(d, family, llm.url));
    await c.initialize();
    const s = await c.newSession();
    await c.prompt(s, 'Hi');
    assert.match(c.text(s).join(''), /Use copilot-min --acp instead/);
    assert.equal(llm.requests.filter(r => r.body.tools).length, 0, 'no model call');
    validateWire(c.wire);
  } finally {
    await c?.close();
    llm.close();
    rmSync(d.dir, { recursive: true, force: true });
  }
});

test('install.sh replaces the guard of an earlier install, and the adapter gets through', async () => {
  const d = scratch();
  const llm = await startFakeLlm({ parent: [{ text: 'upgraded' }], subagent: [] });
  let c: Connection | undefined;
  try {
    mkdirSync(copilotHome(d));
    copyFileSync(join(import.meta.dirname, 'settings-971830b.json'), join(copilotHome(d), 'settings.json'));
    install(d, 'y');
    const hooks = JSON.parse(readFileSync(join(copilotHome(d), 'settings.json'), 'utf8')).hooks.userPromptSubmitted;
    assert.deepEqual(hooks, JSON.parse(readFileSync(join(ours, 'settings.json'), 'utf8')).hooks.userPromptSubmitted, 'one guard, the new one');
    c = adapter(d, copilotEnv(d, family, llm.url));
    await c.initialize();
    checkMinimal(await turn(c, llm, await c.newSession(), 'Hi', 'upgraded'), family);
  } finally {
    await c?.close();
    llm.close();
    rmSync(d.dir, { recursive: true, force: true });
  }
});
