/**
 * In-memory session manager — one Kilo session per Telegram chat.
 *
 * Status lifecycle: idle → processing → (waiting_interaction) → idle.
 * `cancelCurrentPrompt` aborts any running SSE via AbortController, then
 * resets status to idle.
 */

import type { SessionState } from './types.js';
import { getKiloClient } from './kiloClient.js';
import pino from 'pino';

const logger = pino({ name: 'sessionManager' });

/** Per-chat session store. Keyed by Telegram chat ID (number). */
const sessions = new Map<number, SessionState>();

/**
 * Retrieve or create a session for `chatId`.
 *
 * First call: creates a new Kilo session via the SDK/HTTP client, stores the
 * SessionState, and returns it. Subsequent calls return the existing state.
 *
 * Throws if session creation fails — caller should catch and reply to user.
 */
export async function getOrCreateSession(chatId: number): Promise<SessionState> {
  const existing = sessions.get(chatId);
  if (existing) return existing;

  const client = getKiloClient();
  logger.info({ chatId }, 'Creating new Kilo session');

  const session = await client.session.create({
    project: 'mi-proyecto',
    model: 'claude-3-5-sonnet-20241022',
  });

  const state: SessionState = {
    sessionId: session.id,
    project: 'mi-proyecto',
    model: 'claude-3-5-sonnet-20241022',
    history: [],
    status: 'idle',
  };

  sessions.set(chatId, state);
  logger.info({ chatId, sessionId: session.id }, 'Session created');
  return state;
}

/**
 * Return the session for `chatId`, or `undefined` if none exists.
 */
export function getSession(chatId: number): SessionState | undefined {
  return sessions.get(chatId);
}

/**
 * Merge partial updates into the session for `chatId`. No-op if no session exists.
 */
export function updateSession(chatId: number, update: Partial<SessionState>): void {
  const current = sessions.get(chatId);
  if (!current) {
    logger.warn({ chatId }, 'updateSession called but no session exists');
    return;
  }
  Object.assign(current, update);
}

/**
 * Cancel the currently-running prompt for `chatId`.
 *
 * 1. Aborts the session's AbortController if present.
 * 2. Resets `abortController` and `activePromptId` to undefined.
 * 3. Sets status back to `idle`.
 *
 * Safe to call even when the session is idle (no-op).
 */
export function cancelCurrentPrompt(chatId: number): void {
  const state = sessions.get(chatId);
  if (!state) return;

  if (state.abortController) {
    logger.info({ chatId, sessionId: state.sessionId }, 'Aborting current prompt');
    state.abortController.abort();
    state.abortController = undefined;
  }

  state.activePromptId = undefined;
  state.status = 'idle';
}

/**
 * Reset the session for `chatId`: cancel any running prompt, delete the
 * existing session entry, and create a fresh one.
 *
 * Returns the new SessionState.  Safe to call when no session exists — behaves
 * identically to `getOrCreateSession` in that case.
 */
export async function resetSession(chatId: number): Promise<SessionState> {
  cancelCurrentPrompt(chatId);
  sessions.delete(chatId);
  logger.info({ chatId }, 'Session reset');
  return getOrCreateSession(chatId);
}
