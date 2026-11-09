# copilot-cli

GitHub Copilot CLI with the smallest context that still has subagents, shell, file read/write, web fetch and skills.

A default Copilot CLI session sends about 14,000 tokens before your first word (system prompt about 6,000, tool schemas about 8,000). This setup sends about 2,000: no system prompt, six or seven tools, one subagent type with no prompt either. Both counts are from a GPT model in `-p` mode on a clean install, counted with o200k, and were measured on this repo's earlier setup; the current one adds about 127 tokens to each GPT subagent call (see [What the model gets](#what-the-model-gets)). Claude counts the same request about 1.8 times larger. Copilot bills per token (legacy annual plans still per request), and that fixed part is re-sent on every model call, mostly at the cheaper cached rate.

Tested on Copilot CLI 1.0.105.

## Install

```sh
npm install -g @github/copilot@1.0.105
git clone https://github.com/djosh34/copilot-cli
cd copilot-cli
./install.sh
ln -s "$PWD/bin/copilot-min" ~/.local/bin/copilot-min   # any directory on your PATH
```

`install.sh` merges the setup into your existing Copilot home, `~/.copilot` (or `$COPILOT_HOME`). After that, every `copilot` session is the minimal one, also after `/clear`, `/new`, `/resume` and `--continue`. Your login, sessions and skills stay the ones you already have: nothing to log in again, nothing else to copy.

Before it changes anything, `install.sh` shows a `diff -u` of your `settings.json` against the merged one, lists each existing value that changes, and asks `Apply? [y/N]`. Anything but `y` leaves the file as it was. A different `extension.mjs` (for example after a `git pull`) gets the same diff and question. Running it again when nothing changed does nothing. It needs `jq`.

## Run

```sh
copilot        # the minimal setup, in the current directory
copilot-min    # the same, plus the three flags below
```

`bin/copilot-min` runs `copilot --disable-client-telemetry --no-auto-update --yolo "$@"` in the directory you call it from, so any other `copilot` option works with it too. These three flags have no setting:

| Flag | What it does | Why not a setting |
|---|---|---|
| `--disable-client-telemetry` | No telemetry POST and no releases lookup. | No setting or session field turns them off. |
| `--no-auto-update` | Stays on the installed Copilot version. Without it, `copilot` runs a newer version it has already downloaded, and the extension may not work with that. | `autoUpdate: false` only stops downloads; a version already in `~/.cache/copilot` still runs. |
| `--yolo` | No approval prompts, also in `-p`. | `defaultPermissionMode: "allow-all"` covers interactive sessions only. |

So `copilot -p` needs `--yolo` (or use `copilot-min -p`); without it, `bash` and `web_fetch` get "Denied, no one to approve".

Copilot still asks once per folder whether you trust it; pick "remember" to stop that.

## JetBrains Air

`copilot-min --acp` runs Copilot as an ACP agent for [JetBrains Air](https://www.jetbrains.com/help/air/air-app.html) and other ACP clients. Each session gets the same minimal requests as the terminal, on your own `~/.copilot`: your login, settings, skills and agents. It needs `copilot` and Node.js 20.19+ or 22.12+ (`node`) on your `PATH`. The adapter is written in [`src/acp.mts`](src/acp.mts).

Add it to `~/.config/JetBrains/Air/acp.json` for the Air app on Linux, or to `~/.jetbrains/acp.json` for Air in IDEs:

```json
{
  "agent_servers": {
    "Copilot min": {
      "command": "/abs/path/to/copilot-min",
      "args": ["--acp"]
    }
  }
}
```

Then pick "Copilot min" as the agent in Air. Air's built-in "GitHub Copilot" agent does not use this setup.

What Air gets:

- Tasks you can reopen, the model picker (your account's models), tool calls with file diffs and live shell output, context usage, images and files in prompts, and Copilot login.
- One command, `/compact`. It runs Copilot's own compaction: one model call with Copilot's summary instruction, charged in AI credits like a prompt. Copilot also compacts by itself when the context is 80% full; that can't be turned off.
- No modes and no other slash commands: no plan mode, no autopilot.
- Air's own MCP server (its browser and commit-message tools) is ignored, as are any MCP servers Air passes.
- A task reopened after Air restarts keeps its history, but has no subagents: the `task` tool is gone in that session, and new tasks still have `gp`. Copilot 1.0.105 drops the custom agent's prompt settings when the SDK reopens a session, so `gp` would get Copilot's full subagent prompt ([#102](https://github.com/djosh34/copilot-cli/issues/102#issuecomment-6748485846)).

With BYOK, put Copilot's `COPILOT_PROVIDER_*` variables, or `COPILOT_PROVIDERS_CONFIG` with a list of models for the picker, in the entry's `"env"`.

Plain `copilot --acp` can't be made minimal: Copilot's ACP server never loads extensions ([#75](https://github.com/djosh34/copilot-cli/issues/75)). So the guard refuses its prompts and points to `copilot-min --acp`.

## What is merged into `~/.copilot`

```
~/.copilot/
├── settings.json                        the keys below, merged into yours
└── extensions/minprompt/extension.mjs   empty system prompt, the gp subagent, tool allowlist
```

`settings.json` ([`copilot-min/settings.json`](copilot-min/settings.json)). On a conflict ours wins, except for two lists: `subagents.disabledSubagents` keeps your entries and adds ours (and removes `gp`, our subagent), and `hooks.userPromptSubmitted` puts our hook first and keeps yours after it. It drops an earlier version of our hook (any hook that mentions `minprompt.`), so updating doesn't leave two guards.

| Key | What it does |
|---|---|
| `experimental: true` | Loads the extension. |
| `memory: false` | No memory tool or memory prompt. |
| `ide.autoConnect: false` | No automatic IDE connection. |
| `subagents.disabledSubagents` | Turns off the 7 built-in subagents, so `task` offers only `gp`. |
| `defaultPermissionMode: "allow-all"` | No approval prompts in interactive sessions. |
| `autoUpdate: false` | Doesn't download new Copilot versions. |
| `askUser: false` | Removes the `ask_user` tool. |
| `disabledMcpServers: ["github-mcp-server", "githubiq"]` | Stops the built-in GitHub MCP servers. |
| `remoteExport: false` | No session sync to your GitHub account. |
| `disableAllHooks: false` | Keeps hooks on, so the guard below runs. |
| `hooks.userPromptSubmitted` | The guard: refuses a prompt sent before the extension has loaded (see [When it breaks](#when-it-breaks)), and every prompt of plain `copilot --acp`. It lets `copilot-min --acp` through. |

The extension ([`src/extension.mts`](src/extension.mts)) joins each session and sets ([`src/config.mts`](src/config.mts), shared with `copilot-min --acp`):

| Field | What it does |
|---|---|
| `systemMessage: { mode: 'replace', content: '' }` | Empty main system prompt. |
| `customAgents: [gp]` | The one subagent, `gp`: name and description, no prompt, all 11 of Copilot's prompt parts off. |
| `availableTools` | Allowlist `task, bash, view, apply_patch, create, edit, web_fetch, skill`. GPT models get `bash, apply_patch, view, web_fetch, skill, task`; Claude models get `bash, view, create, edit, web_fetch, skill, task`. |
| `skipCustomInstructions: true` | Skips AGENTS.md, CLAUDE.md and `.github/copilot-instructions.md`. |
| `largeOutput: { maxSizeBytes: 8192 }` | Bash output over 8 KB goes to a temp file and the model gets the first 500 characters; `view` refuses files over 8 KB unless the model sets `forceReadLargeFiles`. Default is 20 KB. |
| `suppressResumeEvent: true` | Joining doesn't add a resume event to the session. |

It also sends `requestPermission: false` with its `session.resume` request, so it doesn't ask to handle permission requests; without that, Copilot denies the extension in `-p` without `--yolo`. Putting it in the join config does nothing: the SDK sets that value itself. It joins again when `/resume` brings back a session that `/new` left open, and writes a ready marker for the guard after each join.

## How the extension runs

Copilot starts one extension process per open session, using its own built-in Node, so you need no Node of your own to run it. `/new` leaves the earlier session's extension running until you `/exit`. Each one is about 67 MB. No model traffic goes through it: it only sets the session up, and Copilot makes every model call itself.

## What the model gets

- **Main agent:** no system prompt, only the tool descriptions and the current date and time on each message: no working directory, OS, safety rules or AGENTS.md.
- **`gp` subagent:** no system prompt on Claude. On GPT, Copilot adds its `<subagent_usage>` block (about 127 tokens), which the extension can't remove.

Agent files you add (`~/.copilot/agents`, a repo's `.github/agents` or `.claude/agents`) show up in `task` next to `gp`. To keep only `gp`, add their names to `subagents.disabledSubagents` in `~/.copilot/settings.json`.

Skills are your own, in `~/.copilot/skills` or a repo's skill folders. A `SKILL.md` without the `name` and `description` frontmatter is silently ignored. The `skill` tool costs about 400 tokens on the main agent and 160 per subagent call, plus about 40 per skill (measured on the earlier setup).

## When it breaks

Right after start, `/clear`, `/new` or `/resume`, the extension takes about half a second to load. A prompt sent before then is refused with:

```
! Minimal prompt not loaded yet. Send your prompt again.
```

Press Up and Enter to send it again. Without this guard, such a prompt would go out with Copilot's full system prompt and tools.

The extension uses internal Copilot SDK calls and may stop working with another Copilot version. Then every prompt is refused with that message. Check that `copilot --version` says 1.0.105, and look in `~/.copilot/logs/` for the extension's errors.

## Measured

On this repo's earlier setup (separate Copilot home, run flags, an extension that also edited subagent requests): an interactive session on the real Copilot route (Auto picked gpt-5.6-luna), after one prompt that started a `gp` subagent running `echo` and ran `echo` itself. `/context` showed:

| | Tokens |
|---|---:|
| System prompt | 4 |
| Tool schemas | 2,000 |
| MCP tools | 0 |
| Messages | 312 |

The whole session cost 0.14 AI credits. Full captures, every tool schema and the default system prompt are in [the research issues](https://github.com/djosh34/copilot-cli/issues/1).

## Develop

The extension is written in `src/extension.mts` and built into `copilot-min/extensions/minprompt/extension.mjs`. The ACP adapter is written in `src/acp.mts` and built into `copilot-min/acp/adapter.mjs`, with `@agentclientprotocol/sdk` and `zod` bundled in. Both are committed so installing needs no build.

```sh
npm ci
npm run build   # tsc typecheck against @github/copilot-sdk 1.0.28 (built for Copilot CLI 1.0.105), then esbuild
npm test        # typecheck, then the end-to-end tests against a fake model
npm run tck -- -k 'not test_agent_connects_to_the_stdio_mcp_server'   # the ACP test kit, as CI runs it (needs uv)
shellcheck install.sh bin/copilot-min
```

The test starts a fake model server (`test/fake-llm.ts`) and runs Copilot CLI 1.0.105 in BYOK mode in a throwaway `HOME`, so it needs no login, token or AI. It needs `jq` and `tmux`. It checks:

- `install.sh` into an empty `~/.copilot`, and into one with its own settings and hooks: the preview, `n` changes nothing, `y` merges, a second run changes nothing.
- `copilot -p --yolo`, `copilot-min -p` and `copilot -p` without `--yolo`, for a GPT and a Claude model: no system text in main requests, only `<subagent_usage>` in GPT subagent requests, the tool lists above, `task` offers only `gp`, and both subagents read a file and their results reach the main agent.
- Interactive `copilot` in tmux, both models: a prompt, `/clear`, a prompt, `/new`, a prompt, each with the same checks.
- The guard: with the ready marker moved aside, a prompt is refused and nothing reaches the model; with it back, the prompt goes out minimal.
- `copilot-min --acp` with the official ACP client, both models: every raw message matches the ACP v1 JSON schema; two sessions in one process, each with a `gp` subagent; text, embedded text resources, resource links and images; streamed text; tool updates with kind, absolute paths, diffs and live output; usage; cancel; the client's MCP server gets nothing; AGENTS.md isn't sent; large output goes to a file; skills and your own agents show up; `github-mcp-server` is disabled; no permission requests to the client.
- On a two-model BYOK catalog: the model picker and a switch (every later request names the new model), `/compact` as the only command, session list and close, and a reopened session in a new process (history replayed, no subagents). Without login or BYOK, the adapter asks for login. All with the same checks on every model request, including the compaction request.
- Plain `copilot --acp` is refused with no model call, and `install.sh` replaces the guard of an earlier install.

It can't reach the WebSocket path the real Copilot route uses.
