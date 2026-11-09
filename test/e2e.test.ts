// Installs the setup with install.sh into a throwaway ~/.copilot, runs plain copilot and bin/copilot-min against a
// fake model, and checks what Copilot sent: no system text, the expected tools, only the gp subagent, and that the
// subagents read the file and their results reached the main agent. Also checks the install merge and the guard hook.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { checkCalls, copilotEnv, copilotHome, families, install, killGroup, ours, root, runCopilot, scratch, twoSubagents, waitFor } from './common.ts';
import { startFakeLlm } from './fake-llm.ts';

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
    const ext = join(copilotHome(d), 'extensions/minprompt/extension.mjs');
    mkdirSync(join(copilotHome(d), 'extensions/minprompt'), { recursive: true });
    writeFileSync(settings, existing);
    writeFileSync(ext, '// an older extension\n');

    const preview = install(d, 'n\nn');
    assert.equal(readFileSync(settings, 'utf8'), existing, '"n" leaves the file byte-identical');
    assert.equal(readFileSync(ext, 'utf8'), '// an older extension\n', '"n" leaves the extension');
    assert.match(preview, /^-\/\/ an older extension$/m, 'extension diff');
    assert.match(preview, /^--- .*settings\.json\n\+\+\+ .*settings\.json \(merged\)\n/m, 'diff -u preview');
    assert.match(preview, /^-  "disableAllHooks": true,$/m);
    assert.match(preview, /^\+  "disableAllHooks": false,$/m);
    for (const line of ['ide.autoConnect: true -> false', 'disableAllHooks: true -> false', 'subagents.disabledSubagents: ["my-agent","gp"] -> ', 'hooks.userPromptSubmitted: [{"type":"command","bash":"echo mine"}] -> ']) {
      assert.ok(preview.includes('Existing values that change:') && preview.includes(line), `preview lists ${line}`);
    }

    install(d, 'y\ny');
    assert.equal(readFileSync(ext, 'utf8'), readFileSync(join(ours, 'extensions/minprompt/extension.mjs'), 'utf8'), '"y" replaces the extension');
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
          const stdout = await runCopilot(command.file, ['-p', 'Read hello.txt with two subagents', ...command.args, '--sync-session', 'off'],
            d.project, copilotEnv(d, family, llm.url));
          assert.match(stdout, /parent-done/, command.name);
          checkCalls(llm.requests, family, 2);
        } finally {
          llm.close();
        }
      }

      // Without --yolo the extension must not ask for permission handling, or Copilot denies it and gp goes missing.
      const llm = await startFakeLlm({ parent: [{ text: 'parent-done' }], subagent: [] });
      try {
        const stdout = await runCopilot('copilot', ['-p', 'Say hi', '--sync-session', 'off'], d.project, copilotEnv(d, family, llm.url));
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

for (const family of families) {
  test(`interactive copilot through /clear and /new on ${family.model}`, async () => {
    const d = scratch();
    const tmuxEnv = { PATH: process.env.PATH, TMUX_TMPDIR: d.tmp };
    const tmux = (...args: string[]) => execFileSync('tmux', ['-L', 'copilot-min', ...args], { env: tmuxEnv, encoding: 'utf8', stdio: 'pipe' });
    let pane = 0;
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
      pane = Number(tmux('display-message', '-p', '-t', 'main', '#{pane_pid}'));

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
      if (pane) await killGroup(pane);
      try {
        tmux('kill-server');
      } catch (err) {
        // The server exits by itself once its only pane is gone.
        if (!/no server running|error connecting/.test(String(err))) throw err;
      }
      llm.close();
      rmSync(d.dir, { recursive: true, force: true });
    }
  });
}
