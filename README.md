# copilot-cli

GitHub Copilot CLI with the smallest context that still has subagents, shell, file read/write, web fetch and skills.

A default Copilot CLI session sends about 14,000 tokens before your first word (system prompt about 6,000, tool schemas about 8,000). This setup sends about 2,000: no system prompt, six or seven tools, one subagent type with no prompt either. Both counts are from a GPT model in `-p` mode on a clean install, counted with o200k; Claude counts the same request about 1.8 times larger. Copilot bills per token (legacy annual plans still per request), and that fixed part is re-sent on every model call, mostly at the cheaper cached rate.

Tested on Copilot CLI 1.0.105.

## Install

```sh
npm install -g @github/copilot@1.0.105
git clone https://github.com/djosh34/copilot-cli
mkdir -p ~/.copilot-min && cp -r copilot-cli/copilot-min/. ~/.copilot-min/
```

`~/.copilot-min` is a separate Copilot home, so your normal `copilot` and `~/.copilot` stay as they are. Running the copy again overwrites the files that came from this repo.

## Run

```sh
COPILOT_HOME=~/.copilot-min \
GH_TOKEN=$(gh auth token) \
NODE_USE_ENV_PROXY=1 \
COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES=8192 \
copilot --experimental --yolo --no-auto-update \
  --available-tools=task,bash,view,apply_patch,create,edit,web_fetch,skill \
  --disable-builtin-mcps --no-ask-user --no-custom-instructions \
  --name copilot-min --disable-client-telemetry --sync-session off
```

| Part | What it does |
|---|---|
| `COPILOT_HOME=~/.copilot-min` | Uses the files below instead of `~/.copilot`. |
| `GH_TOKEN=$(gh auth token)` | Logs in with your `gh` login; no `copilot login` needed in the new home. |
| `NODE_USE_ENV_PROXY=1` | Sends the extension's own model calls through `HTTPS_PROXY`. Without it they bypass your proxy. |
| `COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES=8192` | Bash output over 8 KB goes to a temp file and the model gets the first 500 characters; `view` refuses files over 8 KB unless the model sets `forceReadLargeFiles`. Default is 20 KB. Undocumented. |
| `--experimental` | Loads the extension that removes the system prompt. |
| `--yolo` | No approval prompts for tools, paths or URLs. |
| `--no-auto-update` | Stays on the installed Copilot version. Without it, `copilot` runs the newest version your normal Copilot has downloaded, and the extension may not work with it. |
| `--available-tools=...` | Allowlist. GPT models get `bash, apply_patch, view, web_fetch, skill, task`; Claude models get `bash, view, create, edit, web_fetch, skill, task`. Names a model family doesn't have are ignored. |
| `--disable-builtin-mcps` | Stops the GitHub MCP server. For an MCP server a project defines in `.github/mcp.json`, add `--disable-mcp-server <name>`. |
| `--no-ask-user` | Removes the `ask_user` tool. |
| `--no-custom-instructions` | Skips AGENTS.md, CLAUDE.md and `.github/copilot-instructions.md`. |
| `--name copilot-min` | Skips the side call that generates a session title. |
| `--disable-client-telemetry`, `--sync-session off` | No telemetry or session upload. |

Copilot still asks once per folder whether you trust it; pick "remember" to stop that.

## What's in `~/.copilot-min`

```
copilot-min/
├── extensions/minprompt/extension.mjs   empty system prompt; strips Copilot's system text from subagent requests
├── agents/gp.agent.md                   the one subagent: name and description, no prompt
├── settings.json                        built-in subagents off, memory off, IDE auto-connect off
└── skills/                              your skills, one folder each
```

`settings.json`:

```json
{
  "memory": false,
  "ide": { "autoConnect": false },
  "subagents": {
    "disabledSubagents": ["explore", "task", "general-purpose", "code-review", "research", "security-review", "rubber-duck"]
  }
}
```

`agents/gp.agent.md`:

```markdown
---
name: gp
description: General-purpose agent.
---
```

Add a skill, for example one called `commit`:

```sh
mkdir -p ~/.copilot-min/skills/commit
cat > ~/.copilot-min/skills/commit/SKILL.md <<'EOF'
---
name: commit
description: Write a commit message for the staged changes.
---
Read `git diff --staged` and write a one-line commit message.
EOF
```

A `SKILL.md` without the `name` and `description` frontmatter is silently ignored.

The `skill` tool costs about 400 tokens on the main agent and 160 per subagent call, plus about 40 per skill.

## Measured

Interactive session with the command above, real Copilot route (Auto picked gpt-5.6-luna), after one prompt that started a `gp` subagent running `echo` and ran `echo` itself. `/context` showed:

| | Tokens |
|---|---:|
| System prompt | 4 |
| Tool schemas | 2,000 |
| MCP tools | 0 |
| Messages | 312 |

The whole session cost 0.14 AI credits. Full captures, every tool schema and the default system prompt are in [the research issues](https://github.com/djosh34/copilot-cli/issues/1).

## When it breaks

The extension uses internal Copilot SDK calls and may stop working with another Copilot version. Copilot then still answers, but with its full system prompt: `/context` shows thousands of system prompt tokens instead of 4. Look for `Failed to load extension` in `~/.copilot-min/logs/`, and check that `copilot --version` says 1.0.105.

With no system prompt the model gets only the tool descriptions and the current date and time on each message: no working directory, OS, safety rules or AGENTS.md.

## Develop

The extension is written in `src/extension.mts` and built into `copilot-min/extensions/minprompt/extension.mjs`, which is committed so installing stays a copy.

```sh
npm ci
npm run build   # tsc against @github/copilot-sdk 1.0.28 (built for Copilot CLI 1.0.105)
npm test        # typecheck, then run Copilot CLI 1.0.105 with the Run command above against a fake model
```

The test starts a fake model server (`test/fake-llm.ts`) and runs Copilot in BYOK mode, so it needs no login, token or AI. For a GPT and a Claude model it checks that no main or subagent request carries system text, that the tool list is the one above, that `task` offers only `gp`, and that both subagents read a file and their results reach the main agent. It can't reach the WebSocket path the real Copilot route uses; that part was checked by hand.
