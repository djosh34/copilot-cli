// Installs the setup with install.sh into a throwaway ~/.copilot, runs plain copilot and bin/copilot-min against a
// fake model, and checks what Copilot sent: no system text, the expected tools, only the gp subagent, and that the
// subagents read the file and their results reached the main agent. Also checks the install merge and the guard hook.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { startFakeLlm, type Recorded, type Script } from './fake-llm.ts';

const root = join(import.meta.dirname, '..');
const ours = join(root, 'copilot-min');
const run = promisify(execFile);

const families: { model: string; provider: Record<string, string>; tools: string[] }[] = [
  { model: 'gpt-6-sol', provider: { COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_WIRE_API: 'responses' }, tools: ['bash', 'apply_patch', 'view', 'web_fetch', 'skill', 'task'] },
  { model: 'claude-opus-5.5', provider: { COPILOT_PROVIDER_TYPE: 'anthropic' }, tools: ['bash', 'view', 'create', 'edit', 'web_fetch', 'skill', 'task'] },
];
type Family = (typeof families)[number];

// One throwaway dir per test: HOME, TMPDIR, the project, and a bin dir with copilot and a gh that has no login.
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-min-'));
  const d = { dir, home: join(dir, 'home'), tmp: join(dir, 'tmp'), project: join(dir, 'project'), bin: join(dir, 'bin') };
  for (const p of [d.home, d.tmp, d.project, d.bin]) mkdirSync(p);
  symlinkSync(join(root, 'node_modules/.bin/copilot'), join(d.bin, 'copilot'));
  writeFileSync(join(d.bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(d.project, 'hello.txt'), 'hello from the file\n');
  return d;
}
type Scratch = ReturnType<typeof scratch>;
const copilotHome = (d: Scratch) => join(d.home, '.copilot');

function install(d: Scratch, answer: string) {
  return execFileSync(join(root, 'install.sh'), { input: answer + '\n', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: d.home } });
}

// BYOK against the fake model; the proxy points at a closed port so nothing else leaves the machine.
function copilotEnv(d: Scratch, family: Family, url: string): Record<string, string> {
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

const toolNames = (r: Recorded): string[] => r.body.tools.map((t: any) => t.name ?? t.function?.name);
const systemText = (r: Recorded): unknown[] => [
  ...(r.body.system?.length ? [r.body.system] : []),
  ...(r.body.instructions ? [r.body.instructions] : []),
  ...[...(r.body.input ?? []), ...(r.body.messages ?? [])].filter((m: any) => m.role === 'system' || m.role === 'developer'),
];

// Main requests carry no system text. GPT subagent requests carry only Copilot's <subagent_usage> block, Claude's none.
function checkCalls(requests: Recorded[], family: Family, subagents: number) {
  const calls = requests.filter(r => r.body.tools);
  const main = calls.filter(r => !r.subagent);
  const subagent = calls.filter(r => r.subagent);
  assert.ok(main.length > 0, 'main requests were made');
  assert.equal(subagent.filter(r => JSON.stringify(r.body).includes('hello from the file')).length, subagents, 'the subagents read the file');
  assert.equal(JSON.stringify(main.at(-1)?.body).split('subagent-done').length - 1, subagents, 'the subagent results reached the main agent');
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
    assert.deepEqual((task.parameters ?? task.input_schema).properties.agent_type.enum, ['gp'], `task offers only gp in a ${where} request`);
  }
}

const twoSubagents = (d: Scratch): Script => ({
  parent: [
    { tool: 'task', args: { name: 'reader', agent_type: 'gp', description: 'Read hello.txt', prompt: 'Read hello.txt' } },
    { tool: 'task', args: { name: 'reader2', agent_type: 'gp', description: 'Read hello.txt', prompt: 'Read hello.txt', mode: 'background' } },
    { text: 'parent-done' },
  ],
  subagent: [{ tool: 'view', args: { path: join(d.project, 'hello.txt') } }, { text: 'subagent-done' }],
});

test('install.sh into an empty ~/.copilot writes our files', () => {
  const d = scratch();
  try {
    install(d, 'y');
    assert.equal(readFileSync(join(copilotHome(d), 'settings.json'), 'utf8'), readFileSync(join(ours, 'settings.json'), 'utf8'));
    const ext = 'extensions/minprompt/extension.mjs';
    assert.equal(readFileSync(join(copilotHome(d), ext), 'utf8'), readFileSync(join(ours, ext), 'utf8'));
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }
});

test('install.sh merges into an existing settings.json', () => {
  const d = scratch();
  try {
    const settings = join(copilotHome(d), 'settings.json');
    const userHook = { type: 'command', bash: 'echo mine' };
    const existing = JSON.stringify({
      banner: 'never',
      ide: { autoConnect: true },
      subagents: { disabledSubagents: ['my-agent', 'gp'] },
      disableAllHooks: true,
      hooks: { userPromptSubmitted: [userHook], sessionStart: [userHook] },
    }, null, 2);
    mkdirSync(copilotHome(d));
    writeFileSync(settings, existing);

    const preview = install(d, 'n');
    assert.equal(readFileSync(settings, 'utf8'), existing, '"n" leaves the file byte-identical');
    assert.match(preview, /^--- .*settings\.json\n\+\+\+ .*settings\.json \(merged\)\n/m, 'diff -u preview');
    assert.match(preview, /^-  "disableAllHooks": true,$/m);
    assert.match(preview, /^\+  "disableAllHooks": false,$/m);
    for (const line of ['ide.autoConnect: true -> false', 'disableAllHooks: true -> false', 'subagents.disabledSubagents: ["my-agent","gp"] -> ', 'hooks.userPromptSubmitted: [{"type":"command","bash":"echo mine"}] -> ']) {
      assert.ok(preview.includes('Existing values that change:') && preview.includes(line), `preview lists ${line}`);
    }

    install(d, 'y');
    const merged = JSON.parse(readFileSync(settings, 'utf8'));
    const our = JSON.parse(readFileSync(join(ours, 'settings.json'), 'utf8'));
    assert.equal(merged.banner, 'never', 'own key kept');
    assert.equal(merged.ide.autoConnect, false);
    assert.equal(merged.disableAllHooks, false, 'hooks on');
    assert.deepEqual(merged.subagents.disabledSubagents, [...our.subagents.disabledSubagents, 'my-agent'].sort(), 'own entry kept, gp gone');
    assert.deepEqual(merged.hooks.userPromptSubmitted, [...our.hooks.userPromptSubmitted, userHook], 'our hook first');
    assert.deepEqual(merged.hooks.sessionStart, [userHook], 'other hooks kept');
    for (const key of Object.keys(our).filter(k => !['subagents', 'hooks'].includes(k))) assert.deepEqual(merged[key], our[key], key);

    const after = readFileSync(settings, 'utf8');
    const again = install(d, '');
    assert.match(again, /already has the minimal setup/);
    assert.doesNotMatch(again, /\[y\/N\]/, 'no question when nothing changes');
    assert.equal(readFileSync(settings, 'utf8'), after, 'a second run changes nothing');
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }
});

for (const family of families) {
  test(`copilot -p and copilot-min -p on ${family.model}`, async () => {
    const d = scratch();
    try {
      install(d, 'y');
      const commands = [
        { name: 'copilot -p --yolo', file: 'copilot', args: ['--yolo'] },
        { name: 'copilot-min -p', file: join(root, 'bin/copilot-min'), args: [] },
      ];
      for (const command of commands) {
        const llm = await startFakeLlm(twoSubagents(d));
        try {
          const { stdout } = await run(command.file, ['-p', 'Read hello.txt with two subagents', ...command.args, '--sync-session', 'off'],
            { cwd: d.project, timeout: 180_000, env: copilotEnv(d, family, llm.url) });
          assert.match(stdout, /parent-done/, command.name);
          checkCalls(llm.requests, family, 2);
        } finally {
          llm.close();
        }
      }

      // Without --yolo the extension must not ask for permission handling, or Copilot denies it and gp goes missing.
      const llm = await startFakeLlm({ parent: [{ text: 'parent-done' }], subagent: [] });
      try {
        const { stdout } = await run('copilot', ['-p', 'Say hi', '--sync-session', 'off'],
          { cwd: d.project, timeout: 180_000, env: copilotEnv(d, family, llm.url) });
        assert.match(stdout, /parent-done/);
        checkCalls(llm.requests, family, 0);
      } finally {
        llm.close();
      }
    } finally {
      rmSync(d.dir, { recursive: true, force: true });
    }
  });
}

async function waitFor<T>(what: string, check: () => T | undefined, timeout = 60_000): Promise<T> {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(100)) {
    const value = check();
    if (value) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
}

for (const family of families) {
  test(`interactive copilot through /clear and /new on ${family.model}`, async () => {
    const d = scratch();
    const tmuxEnv = { PATH: process.env.PATH, TMUX_TMPDIR: d.tmp };
    const tmux = (...args: string[]) => execFileSync('tmux', ['-L', 'copilot-min', ...args], { env: tmuxEnv, encoding: 'utf8' });
    const llm = await startFakeLlm({
      parent: [
        { tool: 'task', args: { name: 'reader', agent_type: 'gp', description: 'Read hello.txt', prompt: 'Read hello.txt' } },
        { text: 'parent-done' },
      ],
      subagent: [{ tool: 'view', args: { path: join(d.project, 'hello.txt') } }, { text: 'subagent-done' }],
    });
    try {
      install(d, 'y');
      writeFileSync(join(copilotHome(d), 'config.json'), JSON.stringify({ trustedFolders: [d.project] }));
      // A tmux session gets the tmux server's env, not ours, so the env goes into the command.
      const env = Object.entries(copilotEnv(d, family, llm.url)).map(([k, v]) => `${k}='${v}'`).join(' ');
      writeFileSync(join(d.dir, 'run.sh'), `#!/bin/sh\ncd '${d.project}'\nexec env -i TERM="$TERM" LANG=C.UTF-8 ${env} copilot --sync-session off\n`, { mode: 0o755 });
      tmux('new-session', '-d', '-s', 'main', '-x', '200', '-y', '50', join(d.dir, 'run.sh'));

      const sessions = join(copilotHome(d), 'session-state');
      const markers = () => existsSync(sessions)
        ? readdirSync(sessions).flatMap(s => readdirSync(join(sessions, s)).filter(f => f.startsWith('minprompt.')).map(f => join(sessions, s, f)))
        : [];
      const seen = new Set<string>();
      // The marker of the session that just started, once the time in it has passed.
      const newMarker = () => waitFor('the ready marker', () => markers().find(m => {
        if (seen.has(m)) return false;
        const at = Number(readFileSync(m, 'utf8'));
        return at > 0 && at <= Date.now();
      })).then(m => { seen.add(m); return m; });
      const type = async (text: string) => {
        tmux('send-keys', '-t', 'main', '-l', text);
        await sleep(300);
        tmux('send-keys', '-t', 'main', 'Enter');
      };
      const prompt = async (label: string) => {
        const from = llm.requests.length;
        await type(`Read hello.txt with a subagent (${label})`);
        await waitFor(`the answer to ${label}`, () => llm.requests.slice(from).some(r => !r.subagent && JSON.stringify(r.body).includes('subagent-done')));
        await sleep(500);
        checkCalls(llm.requests.slice(from), family, 1);
      };

      await newMarker();
      await prompt('first');
      await type('/clear');
      await newMarker();
      await prompt('after /clear');
      await type('/new');
      const marker = await newMarker();

      // The guard: without the marker the prompt is refused and nothing reaches the model; with it, it goes out minimal.
      renameSync(marker, marker + '.aside');
      const from = llm.requests.length;
      await type('Read hello.txt with a subagent (guard)');
      await waitFor('the guard message', () => tmux('capture-pane', '-p', '-t', 'main').includes('Minimal prompt not loaded yet. Send your prompt again.'));
      await sleep(2000);
      assert.equal(llm.requests.length, from, 'no model call for a refused prompt');
      renameSync(marker + '.aside', marker);
      await prompt('after /new');
    } finally {
      try {
        tmux('kill-server');
      } catch (err) {
        if (!String(err).includes('no server running')) throw err;
      }
      llm.close();
      rmSync(d.dir, { recursive: true, force: true });
    }
  });
}
