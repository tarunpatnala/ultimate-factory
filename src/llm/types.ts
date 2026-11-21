export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  json?: boolean;
  /** Label for metadata/logging, e.g. "triage" or "review/security-engineer". */
  purpose?: string;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  servedModel: string;
  promptTokens: number;
  completionTokens: number;
  usageEstimated: boolean;
  latencyMs: number;
  attempts: number;
}

export interface LlmLike {
  chat(req: ChatRequest): Promise<ChatResult>;
  readonly label: string;
}
