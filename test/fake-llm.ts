// A fake model provider for Copilot CLI's BYOK mode. It plays a fixed script of tool calls,
// streams them back as OpenAI Responses or Anthropic Messages events, and records every request.
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Step = { tool: string; args: object } | { text: string };
export type Script = { parent: Step[]; subagent: Step[] };
export type Recorded = { subagent: boolean; body: any };

const sse = (events: object[]) => events.map(e => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

// The step to play is the number of tool results already sent back, so side requests don't shift it.
function toolResults(body: any): number {
  const input = (body.input ?? []).filter((i: any) => i.type === 'function_call_output');
  const messages = (body.messages ?? []).flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .filter((c: any) => c.type === 'tool_result');
  return input.length + messages.length;
}

function responses(step: Step, n: number): string {
  const item = 'tool' in step
    ? { id: `fc_${n}`, type: 'function_call', status: 'completed', call_id: `call_${n}`, name: step.tool, arguments: JSON.stringify(step.args) }
    : { id: `msg_${n}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: step.text, annotations: [] }] };
  const usage = { input_tokens: 0, output_tokens: 1, total_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
  const response = { id: `resp_${n}`, object: 'response', created_at: 0, status: 'completed', model: 'fake', output: [item], usage };
  return sse([
    { type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', sequence_number: 1, output_index: 0, item },
    { type: 'response.completed', sequence_number: 2, response },
  ]);
}

function messages(step: Step, n: number): string {
  const tool = 'tool' in step;
  const block = tool ? { type: 'tool_use', id: `toolu_${n}`, name: step.tool, input: {} } : { type: 'text', text: '' };
  const delta = tool ? { type: 'input_json_delta', partial_json: JSON.stringify(step.args) } : { type: 'text_delta', text: step.text };
  const stop = tool ? 'tool_use' : 'end_turn';
  return sse([
    { type: 'message_start', message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'fake', content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: block },
    { type: 'content_block_delta', index: 0, delta },
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

export async function startFakeLlm(script: Script) {
  const requests: Recorded[] = [];
  let n = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"object":"list","data":[]}');
      return;
    }
    const body = await readBody(req);
    const subagent = req.headers['x-interaction-type'] === 'conversation-subagent';
    requests.push({ subagent, body });
    const steps = subagent ? script.subagent : script.parent;
    const step = steps[toolResults(body)] ?? steps[steps.length - 1];
    const events = req.url?.endsWith('/responses') ? responses(step, ++n) : messages(step, ++n);
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(events);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => server.close() };
}
