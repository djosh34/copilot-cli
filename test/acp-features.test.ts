// The ACP features of copilot-min --acp on a named BYOK catalog with two fake models: the model picker and a switch,
// rich tool updates, usage, images, /compact, and session list, close and load. Also the login check without BYOK.
// Every raw message is checked against the ACP v1 schema and every model request with checkMinimal/checkCalls.
import type * as acp from '@agentclientprotocol/sdk';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import { adapter, oneSubagent, turn, validateWire, type Connection } from './acp-client.ts';
import { catalogEnv, catalogFamily, checkCalls, checkMinimal, copilotEnv, families, install, scratch, secondModel } from './common.ts';
import { startFakeLlm, type Recorded } from './fake-llm.ts';

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const models = (requests: Recorded[]) => [...new Set(requests.map(r => r.body.model))];
const updatesOf = (c: Connection, sessionId: string, kind: string) =>
  c.updates.filter(u => u.sessionId === sessionId && u.update.sessionUpdate === kind).map(u => u.update as any);

for (const base of families) {
  // On the catalog both families edit with create and edit; apply_patch diffs are in acp.test.ts.
  const family = catalogFamily(base);
  const [first, second] = [`fake/${family.model}`, `fake/${secondModel(family)}`];
  test(`copilot-min --acp features on ${family.model}`, async () => {
    const d = scratch();
    const llm = await startFakeLlm(oneSubagent(d));
    const env = catalogEnv(d, family, llm.url);
    let c: Connection | undefined;
    let c2: Connection | undefined;
    try {
      install(d, 'y');
      c = adapter(d, env);
      const init = await c.initialize();
      assert.equal(init.agentCapabilities?.loadSession, true);
      assert.deepEqual(init.agentCapabilities?.sessionCapabilities, { list: {}, close: {} });
      assert.equal(init.agentCapabilities?.promptCapabilities?.image, true);
      assert.deepEqual(init.authMethods!.map(m => m.id), ['copilot-login']);
      assert.ok(!('modes' in init), 'no modes');

      // The picker offers the catalog's two models; only /compact is offered as a command; no modes.
      const created = await c.agent.request('session/new', { cwd: d.project, mcpServers: [] });
      const s = created.sessionId;
      assert.ok(!('modes' in created), 'no modes');
      const [model] = created.configOptions!;
      assert.equal(created.configOptions!.length, 1);
      assert.deepEqual({ id: model.id, type: model.type, currentValue: model.currentValue }, { id: 'model', type: 'select', currentValue: first });
      assert.deepEqual((model as acp.SessionConfigSelect).options.map((o: any) => o.value), [first, second]);

      // A gp subagent reads the file, on the first model.
      let requests = await turn(c, llm, s, 'Read hello.txt with a subagent', 'parent-done');
      checkCalls(requests, family, 1);
      assert.deepEqual(models(requests), [family.model]);
      assert.deepEqual(updatesOf(c, s, 'available_commands_update').map(u => u.availableCommands.map((a: any) => a.name)), [['compact']]);

      // Tool updates: kind, absolute locations, live bash output, diffs of edits.
      writeFileSync(join(d.project, 'a.txt'), 'one\ntwo\n');
      llm.script = {
        parent: [
          { tool: 'view', args: { path: join(d.project, 'hello.txt') } },
          { tool: 'bash', args: { command: 'echo live-1; sleep 1; echo live-2', description: 'live' } },
          { tool: 'edit', args: { path: join(d.project, 'a.txt'), old_str: 'two', new_str: 'TWO' } },
          { tool: 'create', args: { path: join(d.project, 'b.txt'), file_text: 'new file\n' } },
          { text: 'tools-done' },
        ],
        subagent: [],
      };
      const before = updatesOf(c, s, 'tool_call').length;
      checkMinimal(await turn(c, llm, s, 'Use the tools', 'tools-done'), family);
      assert.equal(readFileSync(join(d.project, 'a.txt'), 'utf8'), 'one\nTWO\n');
      const calls = updatesOf(c, s, 'tool_call').slice(before);
      const kind = (name: string) => calls.find(t => t.rawInput && JSON.stringify(t.rawInput).includes(name))?.kind;
      assert.equal(kind('hello.txt'), 'read');
      assert.equal(kind('live-1'), 'execute');
      assert.equal(kind('b.txt'), 'edit');
      assert.deepEqual(calls.find(t => t.kind === 'read').locations, [{ path: join(d.project, 'hello.txt') }]);
      const bash = calls.find(t => t.kind === 'execute').toolCallId;
      const bashUpdates = updatesOf(c, s, 'tool_call_update').filter(u => u.toolCallId === bash);
      assert.ok(bashUpdates.some(u => !u.status && u.content?.[0].content.text === 'live-1\n'), 'live output before the end');
      assert.match(bashUpdates.at(-1).content[0].content.text, /live-1\nlive-2/);
      const diffs = updatesOf(c, s, 'tool_call_update').flatMap(u => u.content ?? []).filter((x: any) => x.type === 'diff');
      assert.ok(diffs.some((x: any) => x.path === join(d.project, 'a.txt') && x.oldText === 'one\ntwo\n' && x.newText === 'one\nTWO\n'), 'diff of a.txt');
      assert.ok(diffs.some((x: any) => x.path === join(d.project, 'b.txt') && x.oldText === null && x.newText === 'new file\n'), 'diff of the new b.txt');

      // Usage from Copilot's usage events.
      const usage = updatesOf(c, s, 'usage_update').at(-1);
      assert.ok(usage.used > 0 && usage.size > 0, JSON.stringify(usage));

      // An image reaches the model.
      llm.script = { parent: [{ text: 'image-ok' }], subagent: [] };
      requests = await turn(c, llm, s, [{ type: 'text', text: 'What is this?' }, { type: 'image', data: pixel, mimeType: 'image/png' }], 'image-ok');
      assert.ok(requests.some(r => JSON.stringify(r.body).includes(pixel)), 'the image reached the model');
      checkMinimal(requests, family);

      // Switch to the second model: every later request names it, and Copilot adds its one-line notice.
      const switched = await c.agent.request('session/set_config_option', { sessionId: s, configId: 'model', value: second });
      assert.equal(switched.configOptions[0].currentValue, second);
      llm.script = oneSubagent(d);
      requests = await turn(c, llm, s, 'Read hello.txt with a subagent', 'parent-done');
      checkCalls(requests, family, 1, 1);
      assert.deepEqual(models(requests), [secondModel(family)]);
      assert.match(JSON.stringify(requests[0].body), /<tools_changed_notice>\\nThe model has been switched from [^<]* to [^<]*\\n<\/tools_changed_notice>/);

      // /compact runs Copilot's compaction: one model request, and the conversation goes on minimal.
      llm.script = { parent: [{ text: 'the summary' }], subagent: [] };
      let from = llm.requests.length;
      assert.equal((await c.prompt(s, '/compact')).stopReason, 'end_turn');
      const compaction = llm.requests.slice(from);
      assert.equal(compaction.length, 1, 'one compaction request');
      checkMinimal(compaction, family);
      assert.match(c.text(s).at(-1)!, /^Compacted: /);
      llm.script = { parent: [{ text: 'after-compact' }], subagent: [] };
      requests = await turn(c, llm, s, 'Go on', 'after-compact');
      checkMinimal(requests, family);
      assert.match(JSON.stringify(requests[0].body), /the summary/);
      assert.deepEqual(models(llm.requests.slice(from)), [secondModel(family)]);

      // List and close.
      const { sessions } = await c.agent.request('session/list', { cwd: d.project });
      assert.deepEqual(sessions.map(x => [x.sessionId, x.cwd]), [[s, d.project]]);
      assert.deepEqual(await c.agent.request('session/close', { sessionId: s }), {});
      await assert.rejects(c.prompt(s, 'Hi'), 'a closed session takes no prompt');
      validateWire(c.wire);
      await c.close();

      // A new process loads it, as Air does when it reopens a task: history replayed, the second model still on.
      c2 = adapter(d, env);
      await c2.initialize();
      const loaded = await c2.agent.request('session/load', { sessionId: s, cwd: d.project, mcpServers: [] });
      assert.equal(loaded.configOptions![0].currentValue, second);
      const replay = c2.updates.filter(u => u.sessionId === s).map(u => u.update);
      const said = (kind: string) => replay.filter(u => u.sessionUpdate === kind).map(u => (u as any).content.text);
      assert.deepEqual(said('user_message_chunk'), ['Read hello.txt with a subagent', 'Use the tools', 'What is this?', 'Read hello.txt with a subagent', 'Go on']);
      assert.ok(said('agent_message_chunk').includes('parent-done'), 'replayed agent text');
      assert.ok(replay.some(u => u.sessionUpdate === 'tool_call' && u.kind === 'execute'), 'replayed tool calls');
      // A loaded session has no subagents: Copilot 1.0.105 drops gp's prompt settings when the SDK reopens a session.
      llm.script = { parent: [{ tool: 'view', args: { path: join(d.project, 'hello.txt') } }, { text: 'loaded-done' }], subagent: [] };
      requests = await turn(c2, llm, s, 'Read hello.txt', 'loaded-done');
      checkMinimal(requests, family, []);
      assert.ok(JSON.stringify(requests.at(-1)!.body).includes('hello from the file'), 'the file was read');
      assert.deepEqual(models(requests), [secondModel(family)]);

      // Every tool location and diff path is absolute (the ACP test kit's ACP-PROMPT-004).
      for (const u of [...c.updates, ...c2.updates].map(x => x.update as any).filter(u => u.sessionUpdate.startsWith('tool_call'))) {
        for (const l of u.locations ?? []) assert.ok(isAbsolute(l.path), l.path);
        for (const x of u.content ?? []) if (x.type === 'diff') assert.ok(isAbsolute(x.path), x.path);
      }
      validateWire(c2.wire);
    } finally {
      await c?.close();
      await c2?.close();
      llm.close();
      rmSync(d.dir, { recursive: true, force: true });
    }
  });
}

test('copilot-min --acp asks for login when there is neither a login nor BYOK', async () => {
  const d = scratch();
  let c: Connection | undefined;
  try {
    install(d, 'y');
    const env = copilotEnv(d, families[0], 'http://127.0.0.1:9');
    for (const key of Object.keys(env)) if (key.startsWith('COPILOT_')) delete env[key];
    c = adapter(d, env);
    const init = await c.initialize();
    assert.deepEqual(init.authMethods![0]._meta?.['terminal-auth'], { command: join(d.bin, 'copilot'), args: ['login'], label: 'Copilot Login' });
    await assert.rejects(c.agent.request('authenticate', { methodId: 'copilot-login' }), (err: any) => err.code === -32000);
    await assert.rejects(c.newSession(), (err: any) => err.code === -32000);
    validateWire(c.wire);
  } finally {
    await c?.close();
    rmSync(d.dir, { recursive: true, force: true });
  }
});
