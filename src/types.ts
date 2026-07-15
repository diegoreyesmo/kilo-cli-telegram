/** Per-chat session state. In-memory Map<chatId, SessionState>, no persistence. */
export interface SessionState {
  sessionId: string;
  project: string;
  model: string;
  history: Array<{ role: string; content: string }>;
  activePromptId?: string;
  status: 'idle' | 'processing' | 'waiting_interaction';
  abortController?: AbortController;
}

/** Per-chat message rendering state: tracks Telegram message IDs for progressive editing. */
export interface MessageGroup {
  thoughtMsgId?: number;
  toolMsgId?: number;
  finalMsgId?: number;
  lastEditTime: number;
}

/** Configuration for the Kilo SDK adapter. */
export interface KiloConfig {
  port?: number;
  configPath?: string;
  baseUrl?: string;
}

/**
 * SSE event types emitted by the Kilo Code server.
 * Discriminated union on `type` field, with a fallback for unknown events.
 */
export type SSEEvent =
  | { type: 'session.next.reasoning.delta'; sessionId: string; delta: string }
  | { type: 'session.next.tool_call'; sessionId: string; tool: string; input: unknown }
  | { type: 'session.next.tool_result'; sessionId: string; output: string }
  | { type: 'session.next.text.delta'; sessionId: string; delta: string }
  | { type: 'session.next.done'; sessionId: string }
  | { type: 'permission.asked'; permissionId: string; tool: string; input: unknown }
  | { type: 'question.asked'; questionId: string; question: string; options?: string[] }
  | { type: string; [key: string]: unknown };
