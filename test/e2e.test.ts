// Runs Copilot CLI with the README's run command and copilot-min/ against a fake model,
// then checks what Copilot sent: no system text, the expected tools, only the gp subagent,
// and that both subagents read the file and their results reached the main agent.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { startFakeLlm, type Recorded } from './fake-llm.ts';

const root = join(import.meta.dirname, '..');
const copilot = join(root, 'node_modules/.bin/copilot');

// The env vars and flags of the README's run command, minus the login and home the test sets itself.
function readmeCommand() {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const block = readme.split('## Run')[1].split('```sh\n')[1].split('```')[0];
  const words = block.replaceAll('\\\n', ' ').split(/\s+/).filter(Boolean);
  const at = words.indexOf('copilot');
  const env = Object.fromEntries(words.slice(0, at).filter(w => /^[A-Z_]+=/.test(w))
    .map(w => [w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1)])
    .filter(([k]) => k !== 'COPILOT_HOME' && k !== 'GH_TOKEN'));
  return { env, args: words.slice(at + 1) };
}

const families = [
  { model: 'gpt-6-sol', provider: { COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_WIRE_API: 'responses' }, tools: ['bash', 'apply_patch', 'view', 'web_fetch', 'skill', 'task'] },
  { model: 'claude-opus-5.5', provider: { COPILOT_PROVIDER_TYPE: 'anthropic' }, tools: ['bash', 'view', 'create', 'edit', 'web_fetch', 'skill', 'task'] },
];

const toolNames = (r: Recorded): string[] => r.body.tools.map((t: any) => t.name ?? t.function?.name);
const systemText = (r: Recorded): unknown[] => [
  ...(r.body.system?.length ? [r.body.system] : []),
  ...(r.body.instructions ? [r.body.instructions] : []),
  ...[...(r.body.input ?? []), ...(r.body.messages ?? [])].filter((m: any) => m.role === 'system' || m.role === 'developer'),
];

for (const family of families) {
  test(`minimal setup on ${family.model}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'copilot-min-'));
    const home = join(dir, 'home');
    const copilotHome = join(dir, 'copilot-home');
    const project = join(dir, 'project');
    cpSync(join(root, 'copilot-min'), copilotHome, { recursive: true });
    mkdirSync(project);
    writeFileSync(join(project, 'hello.txt'), 'hello from the file\n');

    const llm = await startFakeLlm({
      parent: [
        { tool: 'task', args: { name: 'reader', agent_type: 'gp', description: 'Read hello.txt', prompt: 'Read hello.txt' } },
        { tool: 'task', args: { name: 'reader2', agent_type: 'gp', description: 'Read hello.txt', prompt: 'Read hello.txt', mode: 'background' } },
        { text: 'parent-done' },
      ],
      subagent: [
        { tool: 'view', args: { path: join(project, 'hello.txt') } },
        { text: 'subagent-done' },
      ],
    });
    try {
      const { env, args } = readmeCommand();
      const { stdout } = await promisify(execFile)(copilot, ['-p', 'Read hello.txt with two subagents', ...args], {
        cwd: project,
        timeout: 180_000,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          COPILOT_HOME: copilotHome,
          COPILOT_PROVIDER_BASE_URL: llm.url,
          COPILOT_PROVIDER_API_KEY: 'fake',
          COPILOT_MODEL: family.model,
          ...family.provider,
          ...env,
        },
      });

      assert.match(stdout, /parent-done/);
      const calls = llm.requests.filter(r => r.body.tools);
      const main = calls.filter(r => !r.subagent);
      const subagent = calls.filter(r => r.subagent);
      assert.equal(subagent.filter(r => JSON.stringify(r.body).includes('hello from the file')).length, 2, 'both subagents read the file');
      assert.equal(JSON.stringify(main.at(-1)?.body).split('subagent-done').length - 1, 2, 'both subagent results reached the main agent');
      for (const call of calls) {
        assert.deepEqual(systemText(call), [], `no system text in ${call.subagent ? 'subagent' : 'main'} request`);
        assert.deepEqual(toolNames(call), family.tools);
        const task = call.body.tools.find((t: any) => t.name === 'task');
        assert.deepEqual((task.parameters ?? task.input_schema).properties.agent_type.enum, ['gp']);
      }
    } finally {
      llm.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
