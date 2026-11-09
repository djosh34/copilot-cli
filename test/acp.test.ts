// Drives copilot-min --acp (the ACP adapter) with the official ACP SDK's client (test/acp-client.ts), after install.sh in a throwaway
// home, against the fake model. Checks every raw ACP message against the v1 JSON schema, every model request with
// checkMinimal/checkCalls, and the adapter's ACP behaviour. Also checks plain copilot --acp is refused, and that
// install.sh replaces the guard of an earlier install.
import * as acp from '@agentclientprotocol/sdk';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { adapter, connect, oneSubagent, turn, validateWire, type Connection } from './acp-client.ts';
import { checkCalls, checkMinimal, copilotEnv, copilotHome, families, install, ours, scratch, waitFor, type Family } from './common.ts';
import { holdMarker, startFakeLlm } from './fake-llm.ts';

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

      // GPT edits with apply_patch on a relative path: the tool update carries the diff at the absolute path.
      if (family.tools.includes('apply_patch')) {
        writeFileSync(join(d.project, 'a.txt'), 'one\ntwo\n');
        llm.script = { parent: [{ tool: 'apply_patch', args: { input: '*** Begin Patch\n*** Update File: a.txt\n@@\n one\n-two\n+TWO\n*** End Patch\n' } }, { text: 'patched' }], subagent: [] };
        const patched = await c.newSession();
        checkMinimal(await turn(c, llm, patched, 'Patch a.txt', 'patched'), family);
        const updates = c.updates.filter(u => u.sessionId === patched).map(u => u.update as any);
        assert.deepEqual(updates.find(u => u.sessionUpdate === 'tool_call').locations, [{ path: join(d.project, 'a.txt') }]);
        const diffs = updates.flatMap(u => u.content ?? []).filter((x: any) => x.type === 'diff');
        assert.deepEqual(diffs[0], { type: 'diff', path: join(d.project, 'a.txt'), oldText: 'one\ntwo\n', newText: 'one\nTWO\n' });
      }

      // A failing subagent doesn't end the prompt: the task tool fails, then the main agent answers.
      llm.script = { parent: oneSubagent(d).parent, subagent: [{ status: 400 }] };
      const failing = await c.newSession();
      await turn(c, llm, failing, 'Read hello.txt with a subagent', 'parent-done');
      const response = c.wire.findLastIndex(w => w.from === 'agent' && w.message.result?.stopReason);
      const taskEnd = c.wire.findIndex(w => w.message.params?.sessionId === failing && w.message.params.update?.status === 'failed');
      assert.ok(taskEnd >= 0 && taskEnd < response, 'the failed task tool ends before the prompt does');

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
        assert.ok(ends.some(e => e.sessionId === s.sessionId && (e.update as acp.ToolCallUpdate).toolCallId === id && ['completed', 'failed'].includes((e.update as acp.ToolCallUpdate).status!)), `end of ${id}`);
      }
      assert.equal(c.permissionAsks(), 0, 'no session/request_permission');
      assert.equal(mcp.seen(), 0, 'no request to the client MCP server');
      assert.match(c.stderr(), new RegExp(`session ${a}: MCP servers: github-mcp-server disabled`), 'the built-in GitHub MCP server is off');

      // With an agent of your own, task offers gp and that agent.
      mkdirSync(join(copilotHome(d), 'agents'));
      writeFileSync(join(copilotHome(d), 'agents/own.agent.md'), '---\nname: own\ndescription: My own agent.\n---\nBe brief.\n');
      llm.script = { parent: [{ text: 'own-ok' }], subagent: [] };
      checkMinimal(await turn(c, llm, await c.newSession(), 'Hi', 'own-ok'), family, ['gp', 'own']);

      // When Copilot goes away during a turn, the prompt fails instead of hanging.
      const lost = c.prompt(await c.newSession(), `Wait ${holdMarker}`);
      await waitFor('the held model request', () => llm.held() > 0);
      execFileSync('pkill', ['-KILL', '-g', String(c.pid), '-f', '--', '--headless']);
      await Promise.race([
        assert.rejects(lost, 'the prompt fails'),
        sleep(30_000).then(() => assert.fail('the prompt is still pending 30 s after Copilot died')),
      ]);

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
    assert.equal(llm.requests.length, 0, 'no model call');
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
