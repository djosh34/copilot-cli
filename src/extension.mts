// Empties the main system prompt, defines the gp subagent with Copilot's prompt parts off, and sets the
// tool allowlist, no custom instructions and the 8 KB output limit. No request handler.
// Uses internal Copilot SDK calls; tested on Copilot CLI 1.0.105 only.
import { CopilotClient, type CopilotClientOptions } from '@github/copilot-sdk';
import { rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

const off = {
  includeAISafety: false, includeToolInstructions: false, includeParallelToolCalling: false,
  includeEnvironmentContext: false, includeNoTmpFileInstructions: false, includeSoftFileOutputInstructions: false,
  includeCustomAgentInstructions: false, includeCustomInstructions: false, includeDynamicContextBoard: false,
  includeSessionSearchContext: false, includeConsolidationPrompt: false,
};
const config = {
  systemMessage: { mode: 'replace', content: '' },
  customAgents: [{ name: 'gp', description: 'General-purpose agent.', prompt: '', promptParts: off }],
  availableTools: ['task', 'bash', 'view', 'apply_patch', 'create', 'edit', 'web_fetch', 'skill'],
  skipCustomInstructions: true,
  largeOutput: { maxSizeBytes: 8192 },
  suppressResumeEvent: true,
};

// What the SDK's joinSession() does, kept so the extension can join again. Internal, missing from the SDK's types.
type Send = (method: string, params?: any, ...rest: unknown[]) => Promise<unknown>;
type Internal = {
  connection: { sendRequest: Send };
  resumeSessionForExtension(sessionId: string | undefined, config: object, contributions: object): Promise<unknown>;
};
const id = process.env.SESSION_ID;
// Ready marker for the userPromptSubmitted hook in settings.json: this session, this copilot process.
// It holds the time the last join finished plus 500 ms; the hook refuses interactive prompts submitted before then.
const marker = `${process.env.COPILOT_HOME || homedir() + '/.copilot'}/session-state/${id}/minprompt.${process.ppid}`;
const client = new CopilotClient({ _internalConnection: { kind: 'parent-process' } } as CopilotClientOptions);
const internal = client as unknown as Internal;
await client.start();
// Don't ask to handle permission requests, as joinSession() doesn't; else -p without --yolo denies the extension.
// The SDK sets that value itself and ignores it in the join config, so set it on the request.
const send = internal.connection.sendRequest.bind(internal.connection);
internal.connection.sendRequest = (m, p, ...r) => send(m, m === 'session.resume' ? { ...p, requestPermission: false } : p, ...r);
const join = async () => {
  await internal.resumeSessionForExtension(id, config, {});
  writeFileSync(marker, String(Date.now() + 500));
};
await join();
// /new leaves this session open; /resume back to it resets the system prompt until the join below finishes.
client.onLifecycle('session.background', e => { if (e.sessionId === id) rmSync(marker, { force: true }); });
client.onLifecycle('session.foreground', e => { if (e.sessionId === id) join().catch(err => console.error(err)); });
