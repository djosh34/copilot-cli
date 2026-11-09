// A fake model provider for Copilot CLI's BYOK mode. It plays a fixed script of tool calls,
// streams them back as OpenAI Responses or Anthropic Messages events, and records every request.
// A { status } step answers with that HTTP error. A request that contains the hold marker gets no answer until
// release() (or until the client gives up).
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Step = { tool: string; args: object } | { text: string } | { status: number };
export type Script = { parent: Step[]; subagent: Step[] };
export type Recorded = { subagent: boolean; body: any };

const sse = (events: object[]) => events.map(e => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

// The step to play is the number of tool results sent back for tool calls made since the script was set, so side
// requests don't shift it and a new script starts at its first step, also in a session with earlier tool calls.
function toolResults(body: any, since: number): number {
  const input = (body.input ?? []).filter((i: any) => i.type === 'function_call_output').map((i: any) => i.call_id);
  const messages = (body.messages ?? []).flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .filter((c: any) => c.type === 'tool_result').map((c: any) => c.tool_use_id);
  return [...input, ...messages].filter(id => Number(/_(\d+)$/.exec(id)?.[1]) > since).length;
}

// Text streams in two pieces, as a real model streams it.
const halves = (text: string) => [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))];

function responses(step: Exclude<Step, { status: number }>, n: number): string {
  const item = 'tool' in step
    ? { id: `fc_${n}`, type: 'function_call', status: 'completed', call_id: `call_${n}`, name: step.tool, arguments: JSON.stringify(step.args) }
    : { id: `msg_${n}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: step.text, annotations: [] }] };
  const usage = { input_tokens: 0, output_tokens: 1, total_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
  const response = { id: `resp_${n}`, object: 'response', created_at: 0, status: 'completed', model: 'fake', output: [item], usage };
  const deltas = 'text' in step ? halves(step.text) : [];
  return sse([
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    ...deltas.map(delta => ({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta })),
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ].map((e, i) => ({ ...e, sequence_number: i })));
}

function messages(step: Exclude<Step, { status: number }>, n: number): string {
  const tool = 'tool' in step;
  const block = tool ? { type: 'tool_use', id: `toolu_${n}`, name: step.tool, input: {} } : { type: 'text', text: '' };
  const deltas = tool ? [{ type: 'input_json_delta', partial_json: JSON.stringify(step.args) }] : halves(step.text).map(text => ({ type: 'text_delta', text }));
  const stop = tool ? 'tool_use' : 'end_turn';
  return sse([
    { type: 'message_start', message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'fake', content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: block },
    ...deltas.map(delta => ({ type: 'content_block_delta', index: 0, delta })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]);
}

async function readBody(req: IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

export const holdMarker = 'HOLD-THIS-RESPONSE';

export async function startFakeLlm(initial: Script) {
  const requests: Recorded[] = [];
  const held: (() => void)[] = [];
  let n = 0;
  let script = initial;
  let scriptStart = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"object":"list","data":[]}');
      return;
    }
    const body = await readBody(req);
    const subagent = req.headers['x-interaction-type'] === 'conversation-subagent';
    requests.push({ subagent, body });
    const steps = subagent ? script.subagent : script.parent;
    const step = steps[toolResults(body, scriptStart)] ?? steps[steps.length - 1];
    const answer = 'status' in step
      ? () => res.writeHead(step.status, { 'content-type': 'application/json' }).end('{"error":{"type":"invalid_request_error","message":"fake failure"}}')
      : () => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(req.url?.endsWith('/responses') ? responses(step, ++n) : messages(step, ++n));
    if (JSON.stringify(body).includes(holdMarker)) held.push(answer);
    else answer();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const llm = {
    url: `http://127.0.0.1:${port}`,
    requests,
    get script() {
      return script;
    },
    set script(next: Script) {
      script = next;
      scriptStart = n;
    },
    held: () => held.length,
    release: () => held.splice(0).forEach(answer => answer()),
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
  return llm;
}
