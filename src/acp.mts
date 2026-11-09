// copilot-min --acp: an ACP agent for JetBrains Air and other ACP clients. Each ACP session is a Copilot SDK session
// with the same minimal config as the terminal, on your own ~/.copilot (login, settings, skills, own agents).
// It ignores the client's MCP servers. Built with the ACP SDK into copilot-min/acp/adapter.mjs.
// Usage: node adapter.mjs <path to copilot> [extra copilot options]
import * as acp from '@agentclientprotocol/sdk';
import type * as Copilot from '@github/copilot-sdk';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { minimal } from './config.mts';

function fail(message: string): never {
  console.error(`copilot-min --acp: ${message}`);
  process.exit(1);
}

const [cli, ...cliArgs] = process.argv.slice(2);
if (!cli) fail('usage: node adapter.mjs <path to copilot> [copilot options]');
// The guard hook in settings.json lets prompts through only when this is set.
process.env.COPILOT_MIN_ADAPTER = '1';

// Copilot's own SDK copy, so it always matches the Copilot that runs. Copilot unpacks it on its first run (also
// for --version) into <cache root>/pkg/<platform>/<version>/, or pkg/universal/<version>/ after an update.
const versionOutput = execFileSync(cli, ['--no-auto-update', '--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const version = /Copilot CLI (\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/.exec(versionOutput)?.[1];
if (!version) fail(`no version in the output of ${cli} --version: ${versionOutput}`);
const cacheRoot = process.env.COPILOT_PKG_CACHE_HOME || process.env.COPILOT_CACHE_HOME
  || (process.platform === 'darwin'
    ? join(homedir(), 'Library/Caches/copilot')
    : join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'copilot'));
const sdkCandidates = [`${process.platform}-${process.arch}`, 'universal']
  .map(platform => join(cacheRoot, 'pkg', platform, version, 'copilot-sdk/index.js'));
const sdkPath = sdkCandidates.find(p => existsSync(p));
if (!sdkPath) fail(`Copilot's SDK copy for ${version} is missing. Looked in:\n${sdkCandidates.join('\n')}`);
const sdk: typeof Copilot = await import(pathToFileURL(sdkPath).href);

// The same as bin/copilot-min's flags: the SDK always adds --no-auto-update, and approveAll below allows all tools
// without asking the client.
const copilot = new sdk.CopilotClient({
  connection: sdk.RuntimeConnection.forStdio({ path: cli, args: ['--disable-client-telemetry', ...cliArgs] }),
});
await copilot.start();

// BYOK: Copilot reads these env vars by itself, but SDK sessions don't.
const env = process.env;
const byok = env.COPILOT_PROVIDER_BASE_URL ? {
  model: env.COPILOT_MODEL,
  provider: {
    baseUrl: env.COPILOT_PROVIDER_BASE_URL,
    apiKey: env.COPILOT_PROVIDER_API_KEY,
    type: env.COPILOT_PROVIDER_TYPE as Copilot.ProviderConfig['type'],
    wireApi: env.COPILOT_PROVIDER_WIRE_API as Copilot.ProviderConfig['wireApi'],
  },
} : {};

type State = { session: Copilot.CopilotSession; turn?: { cancelled: boolean }; streamed: Set<string> };
const sessions = new Map<string, State>();

// What reaches the model: text as is, embedded text resources as their URI and text, resource links as native
// copilot --acp sends them.
function promptText(block: acp.ContentBlock): string {
  if (block.type === 'text') return block.text;
  if (block.type === 'resource_link') return `[Resource link: ${block.uri}]`;
  if (block.type === 'resource' && 'text' in block.resource) return `${block.resource.uri}\n${block.resource.text}`;
  throw acp.RequestError.invalidParams({ type: block.type }, 'Only text, text resources and resource links are supported');
}

function toUpdate(event: Copilot.SessionEvent, state: State): acp.SessionUpdate | undefined {
  switch (event.type) {
    case 'tool.execution_start':
      return { sessionUpdate: 'tool_call', toolCallId: event.data.toolCallId, title: event.data.toolName, kind: 'other', status: 'in_progress', rawInput: event.data.arguments };
    case 'tool.execution_complete':
      return { sessionUpdate: 'tool_call_update', toolCallId: event.data.toolCallId, status: event.data.success ? 'completed' : 'failed', rawOutput: event.data.result ?? event.data.error };
    // Only the main agent's text; a subagent's text reaches the client as its task tool's output.
    case 'assistant.message_delta':
      if (event.agentId || !event.data.deltaContent) return;
      state.streamed.add(event.data.messageId);
      return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.data.deltaContent } };
    case 'assistant.message':
      if (event.agentId || !event.data.content || state.streamed.has(event.data.messageId)) return;
      return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.data.content } };
  }
}

function sessionState(sessionId: string): State {
  const state = sessions.get(sessionId);
  if (!state) throw acp.RequestError.sessionNotFound(sessionId);
  return state;
}

// Logs a failed request to stderr; the ACP SDK then returns it to the client as a JSON-RPC error.
function logged<A extends unknown[], R>(handler: (...args: A) => Promise<R> | R) {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (err) {
      console.error('copilot-min --acp:', err);
      throw err;
    }
  };
}

const app = acp.agent({ name: 'copilot-min' })
  .onRequest('initialize', logged(() => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { promptCapabilities: { embeddedContext: true } },
    agentInfo: { name: 'copilot-min', version },
    authMethods: [],
  })))
  .onRequest('session/new', logged(async ({ params }) => {
    if (!isAbsolute(params.cwd)) throw acp.RequestError.invalidParams({ cwd: params.cwd }, 'cwd must be an absolute path');
    const session = await copilot.createSession({
      ...minimal,
      ...byok,
      enableConfigDiscovery: true,
      requestExtensions: false,
      streaming: true,
      workingDirectory: params.cwd,
      onPermissionRequest: sdk.approveAll,
    });
    const state: State = { session, streamed: new Set() };
    sessions.set(session.sessionId, state);
    session.on(event => {
      const update = toUpdate(event, state);
      if (update) connection.client.notify('session/update', { sessionId: session.sessionId, update })
        .catch(err => console.error('copilot-min --acp: session/update failed:', err));
      // Shows in the client's agent log which MCP servers (your own and Copilot's built-in) this session starts.
      if (event.type === 'session.mcp_servers_loaded') {
        const servers = event.data.servers.map(s => `${s.name} ${s.status}`).join(', ') || 'none';
        console.error(`copilot-min --acp: session ${session.sessionId}: MCP servers: ${servers}`);
      }
    });
    return { sessionId: session.sessionId };
  }))
  .onRequest('session/prompt', logged(async ({ params }) => {
    const state = sessionState(params.sessionId);
    if (state.turn) throw acp.RequestError.invalidRequest({ sessionId: params.sessionId }, 'This session is already running a prompt');
    const prompt = params.prompt.map(promptText).join('\n');
    const turn = { cancelled: false };
    state.turn = turn;
    state.streamed.clear();
    try {
      // Resolves once the main agent is idle and its events are delivered; fails on a Copilot error or when
      // Copilot goes away. A turn has no time limit (the longest timer Node allows, about 24 days).
      await state.session.sendAndWait({ prompt }, 2 ** 31 - 1);
      return { stopReason: turn.cancelled ? 'cancelled' as const : 'end_turn' as const };
    } catch (err) {
      if (turn.cancelled) return { stopReason: 'cancelled' as const };
      throw err;
    } finally {
      state.turn = undefined;
    }
  }))
  // A failed notification can't be answered; the ACP SDK logs it to stderr.
  .onNotification('session/cancel', async ({ params }) => {
    const state = sessionState(params.sessionId);
    if (!state.turn) return;
    state.turn.cancelled = true;
    await state.session.abort();
  });

const connection = app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
await connection.closed;
const errors = await copilot.stop();
for (const err of errors) console.error('copilot-min --acp: stopping Copilot:', err);
process.exit(errors.length ? 1 : 0);
