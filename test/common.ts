// Helpers shared by the tests: throwaway dirs, install.sh, the BYOK env for the fake model, the checks on what
// Copilot sent, and running Copilot without leaving processes behind.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Recorded, Script } from './fake-llm.ts';

export const root = join(import.meta.dirname, '..');
export const ours = join(root, 'copilot-min');

export const families: { model: string; provider: Record<string, string>; tools: string[] }[] = [
  { model: 'gpt-6-sol', provider: { COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_WIRE_API: 'responses' }, tools: ['bash', 'apply_patch', 'view', 'web_fetch', 'skill', 'task'] },
  { model: 'claude-opus-5.5', provider: { COPILOT_PROVIDER_TYPE: 'anthropic' }, tools: ['bash', 'view', 'create', 'edit', 'web_fetch', 'skill', 'task'] },
];
export type Family = (typeof families)[number];

// One throwaway dir per test: HOME, TMPDIR, the project, and a bin dir with copilot and a gh that has no login.
export function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-min-'));
  const d = { dir, home: join(dir, 'home'), tmp: join(dir, 'tmp'), project: join(dir, 'project'), bin: join(dir, 'bin') };
  for (const p of [d.home, d.tmp, d.project, d.bin]) mkdirSync(p);
  symlinkSync(join(root, 'node_modules/.bin/copilot'), join(d.bin, 'copilot'));
  writeFileSync(join(d.bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(d.project, 'hello.txt'), 'hello from the file\n');
  return d;
}
export type Scratch = ReturnType<typeof scratch>;
export const copilotHome = (d: Scratch) => join(d.home, '.copilot');

export function install(d: Scratch, answer: string) {
  return execFileSync(join(root, 'install.sh'), { input: answer + '\n', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: d.home } });
}

// BYOK against the fake model; the proxy points at a closed port so nothing else leaves the machine.
export function copilotEnv(d: Scratch, family: Family, url: string): Record<string, string> {
  return {
    PATH: `${d.bin}:${process.env.PATH}`,
    HOME: d.home,
    TMPDIR: d.tmp,
    HTTPS_PROXY: 'http://127.0.0.1:9',
    HTTP_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
    COPILOT_PROVIDER_BASE_URL: url,
    COPILOT_PROVIDER_API_KEY: 'fake',
    COPILOT_MODEL: family.model,
    ...family.provider,
  };
}

export const toolNames = (r: Recorded): string[] => r.body.tools.map((t: any) => t.name ?? t.function?.name);
export const systemText = (r: Recorded): unknown[] => [
  ...(r.body.system?.length ? [r.body.system] : []),
  ...(r.body.instructions ? [r.body.instructions] : []),
  ...[...(r.body.input ?? []), ...(r.body.messages ?? [])].filter((m: any) => m.role === 'system' || m.role === 'developer'),
];

// Every request is minimal: no system text in main requests, only Copilot's <subagent_usage> block in GPT subagent
// requests (Claude's have none), the family's tools, and task offers exactly `agents`.
export function checkMinimal(requests: Recorded[], family: Family, agents = ['gp']) {
  const calls = requests.filter(r => r.body.tools);
  assert.ok(calls.some(r => !r.subagent), 'main requests were made');
  for (const call of calls) {
    const where = call.subagent ? 'subagent' : 'main';
    const system = systemText(call);
    if (call.subagent && family.model.startsWith('gpt') && system.length) {
      assert.equal(system.length, 1, `one system item in a ${where} request`);
      const item = system[0] as { content?: { text?: string }[] };
      const text = typeof item === 'string' ? item : item.content?.map(c => c.text).join('');
      assert.match(text ?? '', /^<subagent_usage>\n[^<]*\n<\/subagent_usage>$/, `only <subagent_usage> in a ${where} request`);
    } else {
      assert.deepEqual(system, [], `no system text in a ${where} request`);
    }
    assert.deepEqual(toolNames(call), family.tools, `tools of a ${where} request`);
    const task = call.body.tools.find((t: any) => t.name === 'task');
    assert.deepEqual((task.parameters ?? task.input_schema).properties.agent_type.enum, agents, `task offers ${agents} in a ${where} request`);
  }
}

// checkMinimal, plus: `subagents` subagents read the file and their results reached the main agent.
export function checkCalls(requests: Recorded[], family: Family, subagents: number) {
  checkMinimal(requests, family);
  const calls = requests.filter(r => r.body.tools);
  const main = calls.filter(r => !r.subagent);
  assert.equal(calls.filter(r => r.subagent && JSON.stringify(r.body).includes('hello from the file')).length, subagents, 'the subagents read the file');
  assert.equal(JSON.stringify(main.at(-1)?.body).split('subagent-done').length - 1, subagents, 'the subagent results reached the main agent');
}

export const twoSubagents = (d: Scratch): Script => ({
  parent: [
    { tool: 'task', args: { name: 'reader', agent_type: 'gp', description: 'Read hello.txt', prompt: 'Read hello.txt' } },
    { tool: 'task', args: { name: 'reader2', agent_type: 'gp', description: 'Read hello.txt', prompt: 'Read hello.txt', mode: 'background' } },
    { text: 'parent-done' },
  ],
  subagent: [{ tool: 'view', args: { path: join(d.project, 'hello.txt') } }, { text: 'subagent-done' }],
});

export async function waitFor<T>(what: string, check: () => T | undefined, timeout = 60_000): Promise<T> {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(100)) {
    const value = check();
    if (value) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Copilot's native binary outlives a killed npm loader (or tmux kill-server) for a while and keeps writing
// into HOME, so kill the whole process group and wait until it is gone.
export async function killGroup(pgid: number) {
  const alive = () => {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw err;
    }
  };
  if (alive()) process.kill(-pgid, 'SIGKILL');
  await waitFor('the copilot processes to exit', () => !alive(), 10_000);
}

// Runs copilot in its own process group, so a timeout or failure leaves nothing running.
export async function runCopilot(file: string, args: string[], cwd: string, env: Record<string, string>) {
  const child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', s => (stdout += s));
  child.stderr.setEncoding('utf8').on('data', s => (stderr += s));
  try {
    const [code] = await once(child, 'close', { signal: AbortSignal.timeout(180_000) });
    assert.equal(code, 0, `${file} ${args.join(' ')} exited with ${code}\n${stderr}`);
    return stdout;
  } finally {
    if (child.pid) await killGroup(child.pid);
  }
}
