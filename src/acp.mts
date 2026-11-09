// copilot-min --acp: an ACP agent for JetBrains Air and other ACP clients. Each ACP session is a Copilot SDK session
// with the same minimal config as the terminal, on your own ~/.copilot (login, settings, skills, own agents).
// It ignores the client's MCP servers. Built with the ACP SDK into copilot-min/acp/adapter.mjs.
// Usage: node adapter.mjs <path to copilot> [extra copilot options]
import * as acp from '@agentclientprotocol/sdk';
import type * as Copilot from '@github/copilot-sdk';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
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

// BYOK: Copilot reads these env vars by itself, but SDK sessions don't. COPILOT_PROVIDER_* is one provider;
// COPILOT_PROVIDERS_CONFIG names a JSON file with a catalog of providers and models, which the model picker lists.
const env = process.env;
const providersFile = env.COPILOT_PROVIDERS_CONFIG?.trim();
const byok = providersFile ? {
  ...JSON.parse(readFileSync(providersFile, 'utf8')) as Pick<Copilot.SessionConfig, 'providers' | 'models'>,
} : env.COPILOT_PROVIDER_BASE_URL ? {
  provider: {
    baseUrl: env.COPILOT_PROVIDER_BASE_URL,
    apiKey: env.COPILOT_PROVIDER_API_KEY,
    type: env.COPILOT_PROVIDER_TYPE as Copilot.ProviderConfig['type'],
    wireApi: env.COPILOT_PROVIDER_WIRE_API as Copilot.ProviderConfig['wireApi'],
  },
} : undefined;

type State = {
  session: Copilot.CopilotSession;
  cwd: string;
  turn?: { cancelled: boolean };
  streamed: Set<string>;
  // Live bash output and file diffs, per running tool call.
  output: Map<string, string>;
  diffs: Map<string, acp.ToolCallContent[]>;
  models: acp.SessionConfigSelectOption[];
  model?: string;
};
const sessions = new Map<string, State>();

function sessionState(sessionId: string): State {
  const state = sessions.get(sessionId);
  if (!state) throw acp.RequestError.sessionNotFound(sessionId);
  return state;
}

function notify(sessionId: string, update: acp.SessionUpdate) {
  connection.client.notify('session/update', { sessionId, update })
    .catch(err => console.error('copilot-min --acp: session/update failed:', err));
}

// What reaches the model: text as is, embedded text resources as their URI and text, resource links as native
// copilot --acp sends them. Images go as attachments.
function promptText(block: acp.ContentBlock): string {
  if (block.type === 'text') return block.text;
  if (block.type === 'resource_link') return `[Resource link: ${block.uri}]`;
  if (block.type === 'resource' && 'text' in block.resource) return `${block.resource.uri}\n${block.resource.text}`;
  throw acp.RequestError.invalidParams({ type: block.type }, 'Only text, images, text resources and resource links are supported');
}

const toolKinds: Record<string, acp.ToolKind> = { view: 'read', bash: 'execute', apply_patch: 'edit', create: 'edit', edit: 'edit', web_fetch: 'fetch' };

// The files a tool call works on, as absolute paths: a `path` argument, or the files an apply_patch names.
function toolLocations(args: unknown, cwd: string): acp.ToolCallLocation[] {
  const paths = typeof args === 'string'
    ? [...args.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(m => m[1].trim())
    : typeof (args as { path?: unknown })?.path === 'string' ? [(args as { path: string }).path] : [];
  return paths.map(path => ({ path: resolve(cwd, path) }));
}

const textContent = (text: string): acp.ToolCallContent[] => [{ type: 'content', content: { type: 'text', text } }];

// Maps a Copilot session event to an ACP update, live and on replay.
function toUpdate(event: Copilot.SessionEvent, state: State): acp.SessionUpdate | undefined {
  switch (event.type) {
    case 'tool.execution_start':
      return {
        sessionUpdate: 'tool_call', toolCallId: event.data.toolCallId, title: event.data.toolTitle ?? event.data.toolName,
        kind: toolKinds[event.data.toolName] ?? 'other', status: 'in_progress', rawInput: event.data.arguments,
        locations: toolLocations(event.data.arguments, state.cwd),
      };
    // Copilot asks for each file write with the file before and after; approveAll allows it.
    case 'permission.requested': {
      const request = event.data.permissionRequest;
      if (request.kind !== 'write' || !request.toolCallId || !request.fileEdits?.length) return;
      const diffs = state.diffs.get(request.toolCallId) ?? [];
      for (const { before, after } of request.fileEdits) {
        diffs.push({ type: 'diff', path: resolve(state.cwd, (after ?? before)!.path), oldText: before?.content ?? null, newText: after?.content ?? '' });
      }
      state.diffs.set(request.toolCallId, diffs);
      return { sessionUpdate: 'tool_call_update', toolCallId: request.toolCallId, content: diffs, locations: diffs.map(d => ({ path: (d as acp.Diff).path })) };
    }
    case 'tool.shell_output': {
      const output = (state.output.get(event.data.toolCallId) ?? '') + event.data.text;
      state.output.set(event.data.toolCallId, output);
      return { sessionUpdate: 'tool_call_update', toolCallId: event.data.toolCallId, content: textContent(output) };
    }
    case 'tool.execution_complete': {
      const { toolCallId, success, result, error } = event.data;
      const diffs = state.diffs.get(toolCallId);
      state.diffs.delete(toolCallId);
      state.output.delete(toolCallId);
      const text = result?.content ?? error?.message;
      return {
        sessionUpdate: 'tool_call_update', toolCallId, status: success ? 'completed' : 'failed', rawOutput: result ?? error,
        ...(diffs ? { content: diffs } : text ? { content: textContent(text) } : {}),
      };
    }
    // Only the main agent's text; a subagent's text reaches the client as its task tool's output.
    case 'assistant.message_delta':
      if (event.agentId || !event.data.deltaContent) return;
      state.streamed.add(event.data.messageId);
      return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.data.deltaContent } };
    case 'assistant.message':
      if (event.agentId || !event.data.content || state.streamed.has(event.data.messageId)) return;
      return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.data.content } };
    case 'session.usage_info':
      return { sessionUpdate: 'usage_update', used: event.data.currentTokens, size: event.data.tokenLimit };
  }
}

// The model picker: the account's models when logged in; under BYOK the session's own list (the provider catalog),
// since the account list fails there. Plain BYOK has an empty list, so the picker shows the one model.
async function modelOptions(session: Copilot.CopilotSession, current: string | undefined): Promise<acp.SessionConfigSelectOption[]> {
  const models = byok
    ? (await session.rpc.model.list()).list.map(m => m as { id: string; name?: string })
    : await copilot.listModels();
  const options = models.map(m => ({ value: m.id, name: m.name ?? m.id }));
  if (current && !options.some(o => o.value === current)) options.unshift({ value: current, name: current });
  return options;
}

const configOptions = (state: State): acp.SessionConfigOption[] => state.model ? [{
  type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: state.model, options: state.models,
}] : [];

// Login: native copilot --acp's method, which has the client run `copilot login` in a terminal.
const authMethods: acp.AuthMethod[] = [{
  id: 'copilot-login', name: 'Log in with Copilot CLI', description: 'Run `copilot login` in the terminal',
  _meta: { 'terminal-auth': { command: cli, args: ['login'], label: 'Copilot Login' } },
}];
async function checkLogin() {
  if (byok) return;
  const status = await copilot.getAuthStatus();
  if (!status.isAuthenticated) throw acp.RequestError.authRequired(undefined, `${status.statusMessage ?? 'Not logged in'}. Run copilot login.`);
}

function sessionConfig(cwd: string) {
  if (!isAbsolute(cwd)) throw acp.RequestError.invalidParams({ cwd }, 'cwd must be an absolute path');
  return {
    ...minimal,
    ...byok,
    enableConfigDiscovery: true,
    requestExtensions: false,
    streaming: true,
    workingDirectory: cwd,
    onPermissionRequest: sdk.approveAll,
  };
}

const compact: acp.AvailableCommand = { name: 'compact', description: 'Summarize the conversation to free context. Costs a model call.' };

// Sends a session's history to the client, for session/load.
function replay(state: State, history: Copilot.SessionEvent[]) {
  for (const event of history) {
    const update = event.type === 'user.message'
      ? event.agentId ? undefined : { sessionUpdate: 'user_message_chunk' as const, content: { type: 'text' as const, text: event.data.content } }
      : toUpdate(event, state);
    if (update) notify(state.session.sessionId, update);
  }
}

// Starts the ACP side of a Copilot session: replays its history (for session/load), forwards its events, and
// offers the model picker and /compact.
async function open(session: Copilot.CopilotSession, cwd: string, history: Copilot.SessionEvent[] = []) {
  const state: State = { session, cwd, streamed: new Set(), output: new Map(), diffs: new Map(), models: [] };
  sessions.set(session.sessionId, state);
  replay(state, history);
  session.on(event => {
    const update = toUpdate(event, state);
    if (update) notify(session.sessionId, update);
    // Shows in the client's agent log which MCP servers (your own and Copilot's built-in) this session starts.
    if (event.type === 'session.mcp_servers_loaded') {
      const servers = event.data.servers.map(s => `${s.name} ${s.status}`).join(', ') || 'none';
      console.error(`copilot-min --acp: session ${session.sessionId}: MCP servers: ${servers}`);
    }
  });
  // With a login and no model picked yet, Copilot reports none; the picker then shows the first model listed.
  const current = (await session.rpc.model.getCurrent()).modelId;
  state.models = await modelOptions(session, current);
  state.model = current ?? state.models[0]?.value;
  // After the response, so the client knows the session.
  setImmediate(() => notify(session.sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [compact] }));
  return { sessionId: session.sessionId, configOptions: configOptions(state) };
}

async function compactSession(state: State, sessionId: string) {
  const result = await state.session.rpc.history.compact({ trigger: 'manual' });
  if (!result.success) throw new Error('Copilot could not compact the conversation');
  notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Compacted: ${result.messagesRemoved} messages, ${result.tokensRemoved} tokens freed.` } });
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
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      sessionCapabilities: { list: {}, close: {} },
    },
    agentInfo: { name: 'copilot-min', version },
    authMethods,
  })))
  .onRequest('authenticate', logged(async () => {
    await checkLogin();
    return {};
  }))
  .onRequest('session/new', logged(async ({ params }) => {
    const config = sessionConfig(params.cwd);
    await checkLogin();
    // BYOK starts on COPILOT_MODEL, as Copilot does; with a login, Copilot picks the model from your settings.
    return open(await copilot.createSession({ ...config, model: byok ? env.COPILOT_MODEL : undefined }), params.cwd);
  }))
  .onRequest('session/load', logged(async ({ params }) => {
    const config = sessionConfig(params.cwd);
    await checkLogin();
    // A session already open in this process (it may not be on disk yet) only replays its history.
    const already = sessions.get(params.sessionId);
    if (already) {
      replay(already, await already.session.getEvents());
      return { configOptions: configOptions(already) };
    }
    // A loaded session keeps the model it was switched to. It gets no subagents: when the SDK reopens a session,
    // Copilot 1.0.105 drops the custom agent's promptParts, so gp would get Copilot's full subagent prompt (#102).
    const session = await copilot.resumeSession(params.sessionId, {
      ...config,
      customAgents: [],
      availableTools: minimal.availableTools.filter(tool => tool !== 'task'),
    });
    const opened = await open(session, params.cwd, await session.getEvents());
    return { configOptions: opened.configOptions };
  }))
  .onRequest('session/list', logged(async ({ params }) => {
    const list = await copilot.listSessions(params.cwd ? { workingDirectory: params.cwd } : undefined);
    const sessions = list.flatMap(s => s.context?.workingDirectory ? [{
      sessionId: s.sessionId, cwd: s.context.workingDirectory, title: s.summary ?? null, updatedAt: new Date(s.modifiedTime).toISOString(),
    }] : []);
    return { sessions };
  }))
  .onRequest('session/close', logged(async ({ params }) => {
    const state = sessionState(params.sessionId);
    sessions.delete(params.sessionId);
    if (state.turn) {
      state.turn.cancelled = true;
      await state.session.abort();
    }
    await state.session.disconnect();
    return {};
  }))
  .onRequest('session/set_config_option', logged(async ({ params }) => {
    const state = sessionState(params.sessionId);
    const value = 'value' in params ? params.value : undefined;
    if (params.configId !== 'model' || typeof value !== 'string' || !state.models.some(m => m.value === value)) {
      throw acp.RequestError.invalidParams({ configId: params.configId, value }, 'The only option is model, set to one of its values');
    }
    await state.session.setModel(value);
    state.model = value;
    return { configOptions: configOptions(state) };
  }))
  .onRequest('session/prompt', logged(async ({ params }) => {
    const state = sessionState(params.sessionId);
    if (state.turn) throw acp.RequestError.invalidRequest({ sessionId: params.sessionId }, 'This session is already running a prompt');
    const prompt = params.prompt.filter(b => b.type !== 'image').map(promptText).join('\n');
    const attachments = params.prompt.flatMap(b => b.type === 'image' ? [{
      type: 'blob' as const, data: b.data, mimeType: b.mimeType, displayName: b.uri ? basename(b.uri) : 'image',
    }] : []);
    const turn = { cancelled: false };
    state.turn = turn;
    state.streamed.clear();
    try {
      if (prompt.trim() === '/compact' && !attachments.length) {
        await compactSession(state, params.sessionId);
        return { stopReason: 'end_turn' as const };
      }
      // Resolves once the main agent is idle and its events are delivered; fails on a Copilot error or when
      // Copilot goes away. A turn has no time limit (the longest timer Node allows, about 24 days).
      await state.session.sendAndWait({ prompt, attachments }, 2 ** 31 - 1);
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
