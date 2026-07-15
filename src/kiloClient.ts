/**
 * Kilo SDK adapter — connects to a local Kilo Code server.
 *
 * Two modes:
 *   1. SDK mode: uses `@kilocode/sdk` createKilo / createKiloClient when available.
 *   2. Raw HTTP mode: fallback HTTP client wrapping the Kilo REST + SSE endpoints.
 *
 * SSE subscription uses the `eventsource` package, filtered by sessionId.
 * All event parsing includes defensive type checks — malformed or unexpected
 * events are logged and skipped without crashing.
 */

import { EventSource } from 'eventsource';
import type { KiloConfig, SSEEvent } from './types.js';
import pino from 'pino';

const logger = pino({ name: 'kiloClient' });

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------
let kiloClientInstance: unknown = null;
let kiloServer: unknown = null;

let sdkModule: typeof import('@kilocode/sdk') | null | undefined = undefined;

/**
 * Lazily attempt to load @kilocode/sdk. Returns the module on success, null if
 * the package is not installed. Result is cached after the first attempt.
 */
async function tryLoadSDK(): Promise<typeof import('@kilocode/sdk') | null> {
  if (sdkModule !== undefined) return sdkModule;

  try {
    sdkModule = await import('@kilocode/sdk');
    logger.info('@kilocode/sdk loaded successfully');
    return sdkModule;
  } catch {
    logger.warn('@kilocode/sdk not available, using raw HTTP fallback');
    sdkModule = null;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Raw HTTP client (fallback when SDK is not installed)
// ---------------------------------------------------------------------------
interface RawKiloClient {
  baseUrl: string;
  session: {
    create(params: { project: string; model: string }): Promise<{ id: string }>;
    prompt(
      sessionId: string,
      params: { message: string; history?: Array<{ role: string; content: string }> },
    ): Promise<{ promptId: string }>;
  };
  permission: {
    resolve(params: { permissionId: string; approved: boolean }): Promise<void>;
  };
  question: {
    answer(params: { questionId: string; answer: string }): Promise<void>;
  };
}

function createRawHttpClient(config?: Partial<KiloConfig>): RawKiloClient {
  const baseUrl = config?.baseUrl ?? process.env.KILO_SERVER_URL ?? 'http://127.0.0.1:4096';
  const base = baseUrl.replace(/\/+$/, ''); // strip trailing slashes

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Kilo HTTP ${method} ${path} failed (${res.status}): ${text}`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return res.json();
    }
    return res.text();
  }

  return {
    baseUrl: base,
    session: {
      create: (params) =>
        request('POST', '/session', params) as Promise<{ id: string }>,
      prompt: (sessionId, params) =>
        request('POST', `/session/${sessionId}/prompt`, params) as Promise<{ promptId: string }>,
    },
    permission: {
      resolve: (params) =>
        request('POST', '/permission/resolve', params) as Promise<void>,
    },
    question: {
      answer: (params) =>
        request('POST', '/question/answer', params) as Promise<void>,
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the Kilo connection.
 *
 * Prefers `createKilo()` from @kilocode/sdk when available (starts the local
 * server + creates a client). Falls back to a raw HTTP client when the SDK is
 * not installed.
 */
export async function initKilo(
  config?: KiloConfig,
): Promise<{ client: unknown; server: unknown }> {
  const sdk = await tryLoadSDK();

  if (sdk?.createKilo) {
    const result = await sdk.createKilo({
      port: config?.port ?? 4096,
      configPath: config?.configPath,
    });
    kiloClientInstance = result.client;
    kiloServer = result.server;
    return result;
  }

  // Fallback
  kiloClientInstance = createRawHttpClient(config);
  return { client: kiloClientInstance, server: null };
}

/**
 * Return the singleton Kilo client instance.
 *
 * If the client hasn't been initialized yet (no `initKilo` call), this creates
 * a raw HTTP client pointing at `KILO_SERVER_URL` (default `http://127.0.0.1:4096`).
 */
export function getKiloClient(): RawKiloClient {
  if (kiloClientInstance) return kiloClientInstance as RawKiloClient;

  kiloClientInstance = createRawHttpClient();
  return kiloClientInstance as RawKiloClient;
}

// ---------------------------------------------------------------------------
// SSE subscription
// ---------------------------------------------------------------------------

/**
 * Subscribe to SSE events for a given session.
 *
 * Opens an EventSource to `{KILO_SERVER_URL}/global/event`, filters events
 * by `sessionId`, and applies defensive type checks before invoking `onEvent`.
 * Malformed events or events for other sessions are silently skipped.
 *
 * Returns a cleanup function that closes the EventSource connection.
 */
export function subscribeToSessionEvents(
  sessionId: string,
  onEvent: (event: SSEEvent) => void,
  onError: (error: Error) => void,
): () => void {
  const baseUrl = (process.env.KILO_SERVER_URL ?? 'http://127.0.0.1:4096').replace(/\/+$/, '');
  const url = `${baseUrl}/global/event`;

  const eventSource = new EventSource(url);

  eventSource.onmessage = (msg: MessageEvent) => {
    let data: Record<string, unknown>;

    try {
      data = JSON.parse(msg.data as string);
    } catch {
      logger.warn({ raw: msg.data }, 'SSE event is not valid JSON, skipping');
      return;
    }

    if (!data || typeof data !== 'object') {
      logger.warn({ data }, 'SSE event is not an object, skipping');
      return;
    }

    // Filter by sessionId — events without sessionId are passed through
    const eventSessionId = data.sessionId as string | undefined;
    if (eventSessionId !== undefined && eventSessionId !== sessionId) {
      return;
    }

    const eventType = data.type as string | undefined;
    if (typeof eventType !== 'string') {
      logger.warn({ data }, 'SSE event missing type field, skipping');
      return;
    }

    // Defensive type checks per event type (spec: kilo-adapter, design table)
    switch (eventType) {
      case 'session.next.reasoning.delta':
        if (typeof data.delta !== 'string') {
          logger.warn({ data }, 'reasoning.delta missing delta string, skipping');
          return;
        }
        break;

      case 'session.next.text.delta':
        if (typeof data.delta !== 'string') {
          logger.warn({ data }, 'text.delta missing delta string, skipping');
          return;
        }
        break;

      case 'session.next.tool_call':
        if (typeof data.tool !== 'string' || data.input === undefined) {
          logger.warn({ data }, 'tool_call missing tool name or input, skipping');
          return;
        }
        break;

      case 'session.next.tool_result':
        if (typeof data.output !== 'string') {
          logger.warn({ data }, 'tool_result missing output string, skipping');
          return;
        }
        break;

      case 'permission.asked':
        if (typeof data.permissionId !== 'string' || typeof data.tool !== 'string') {
          logger.warn({ data }, 'permission.asked missing permissionId or tool, skipping');
          return;
        }
        break;

      case 'question.asked':
        if (typeof data.questionId !== 'string' || typeof data.question !== 'string') {
          logger.warn({ data }, 'question.asked missing questionId or question, skipping');
          return;
        }
        break;

      case 'session.next.done':
        // No extra required fields
        break;

      default:
        logger.warn({ type: eventType }, 'Unknown SSE event type');
        // Still pass through for forward compatibility
        break;
    }

    onEvent(data as SSEEvent);
  };

  eventSource.onerror = (ev: Event) => {
    const err = ev instanceof Error ? ev : new Error('SSE connection error');
    logger.error({ err }, 'EventSource error');
    onError(err);
  };

  // Return cleanup function (spec: kilo-adapter R4)
  return () => {
    eventSource.close();
  };
}
