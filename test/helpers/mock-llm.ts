import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  url: string;
  headers: IncomingHttpHeaders;
  body: any;
}

export interface MockReply {
  status?: number;
  headers?: Record<string, string>;
  /** Full JSON body; or use content/tool_calls helpers. */
  json?: unknown;
  content?: string;
  tool_calls?: Array<{ name: string; args: Record<string, unknown> }>;
  model?: string;
  noUsage?: boolean;
}

export type Responder = (req: RecordedRequest, index: number) => MockReply;

/**
 * Minimal OpenAI-compatible Chat Completions server for tests. The responder decides each reply
 * from the request (e.g. by inspecting the system prompt or whether tools were offered).
 */
export class MockLlm {
  readonly requests: RecordedRequest[] = [];
  private server?: Server;
  baseUrl = '';

  constructor(private responder: Responder) {}

  setResponder(r: Responder): void {
    this.responder = r;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const rec: RecordedRequest = { url: req.url ?? '', headers: req.headers, body: data ? JSON.parse(data) : {} };
        this.requests.push(rec);
        let reply: MockReply;
        try {
          reply = this.responder(rec, this.requests.length - 1);
        } catch (e) {
          reply = { status: 500, json: { error: { message: String(e) } } };
        }
        const status = reply.status ?? 200;
        const body =
          reply.json ??
          {
            id: `cmpl-${this.requests.length}`,
            object: 'chat.completion',
            model: reply.model ?? rec.body.model,
            choices: [
              {
                index: 0,
                finish_reason: reply.tool_calls?.length ? 'tool_calls' : 'stop',
                message: {
                  role: 'assistant',
                  content: reply.content ?? null,
                  ...(reply.tool_calls?.length
                    ? { tool_calls: reply.tool_calls.map((t, i) => ({ id: `call_${this.requests.length}_${i}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } })) }
                    : {}),
                },
              },
            ],
            ...(reply.noUsage ? {} : { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }),
          };
        res.writeHead(status, { 'content-type': 'application/json', ...(reply.headers ?? {}) });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    const port = (this.server!.address() as AddressInfo).port;
    this.baseUrl = `http://127.0.0.1:${port}/v1`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

export function systemOf(req: RecordedRequest): string {
  return String(req.body.messages?.[0]?.content ?? '');
}
