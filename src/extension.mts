// Empties the main system prompt and strips Copilot's system text from subagent requests.
// Uses internal Copilot SDK calls; tested on Copilot CLI 1.0.105 only.
import {
  CopilotClient,
  CopilotRequestHandler,
  CopilotWebSocketCloseStatus,
  CopilotWebSocketHandler,
  type CopilotClientOptions,
  type CopilotRequestContext,
} from '@github/copilot-sdk';

type Message = { role?: string };
type Body = { type?: string; system?: unknown; instructions?: unknown; input?: Message[]; messages?: Message[] };

const isSubagent = (ctx?: CopilotRequestContext) =>
  !!ctx?.parentAgentId || ctx?.interactionType === 'conversation-subagent';
const notSystem = (m: Message) => m.role !== 'system' && m.role !== 'developer';

function strip(body: Body): Body {
  delete body.system;
  delete body.instructions;
  body.input = body.input?.filter(notSystem);
  body.messages = body.messages?.filter(notSystem);
  return body;
}

// The SDK's default WebSocket forwarder drops the auth headers, so forward them ourselves.
class Forwarder extends CopilotWebSocketHandler {
  private up?: WebSocket;

  constructor(ctx: CopilotRequestContext) {
    super(ctx);
  }

  async start() {
    // Node's WebSocket (undici) also takes { headers }; the standard types only know protocols.
    const init = { headers: this.context.headers } as unknown as string[];
    const up = new WebSocket(this.context.url, init);
    up.binaryType = 'arraybuffer';
    this.up = up;
    up.addEventListener('message', e => {
      const data = typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer);
      this.sendResponseMessage(data).catch(err => this.close(new CopilotWebSocketCloseStatus(String(err), undefined, err)));
    });
    up.addEventListener('close', () => this.close(CopilotWebSocketCloseStatus.normalClosure));
    up.addEventListener('error', () => this.close(new CopilotWebSocketCloseStatus('WebSocket error', undefined, new Error('WebSocket error'))));
    await new Promise<void>((resolve, reject) => {
      up.addEventListener('open', () => resolve(), { once: true });
      up.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true });
    });
  }

  sendRequestMessage(data: string | Uint8Array, ctx?: CopilotRequestContext) {
    let text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    if (isSubagent(ctx ?? this.context)) {
      const body: Body = JSON.parse(text);
      if (body.type === 'response.create') text = JSON.stringify(strip(body));
    }
    if (this.up?.readyState === WebSocket.OPEN) this.up.send(text);
  }

  async close(status = CopilotWebSocketCloseStatus.normalClosure) {
    if (this.up && this.up.readyState <= WebSocket.OPEN) this.up.close();
    await super.close(status);
  }
}

class Handler extends CopilotRequestHandler {
  protected async sendRequest(request: Request, ctx: CopilotRequestContext) {
    if (isSubagent(ctx)) {
      const body = strip(await request.clone().json());
      request = new Request(request, { body: JSON.stringify(body) });
    }
    return super.sendRequest(request, ctx);
  }

  protected async openWebSocket(ctx: CopilotRequestContext) {
    const forwarder = new Forwarder(ctx);
    await forwarder.start();
    return forwarder;
  }
}

// What the SDK's joinSession() does, plus a request handler, which joinSession() doesn't accept.
// Both members are internal and missing from the SDK's types.
type Internal = {
  resumeSessionForExtension(sessionId: string | undefined, config: object, contributions: object): Promise<unknown>;
};
const options = { _internalConnection: { kind: 'parent-process' }, requestHandler: new Handler() } as CopilotClientOptions;
const client = new CopilotClient(options) as unknown as Internal;
await client.resumeSessionForExtension(
  process.env.SESSION_ID,
  { systemMessage: { mode: 'replace', content: '' }, suppressResumeEvent: true },
  {},
);
