/**
 * Message renderer — converts SSE events into progressive Telegram message edits.
 *
 * Three-message strategy per chat:
 *   - thought: reasoning deltas edit the initial "Processing…" placeholder.
 *   - tool:    tool_call creates a new message, tool_result edits it.
 *   - answer:  text.delta creates a new message, subsequent deltas edit it.
 *
 * Throttle: ≥500ms between edits per chat (spec: event-rendering R2).
 * Accumulator buffers implement last-write-wins — only the latest content
 * survives when a scheduled edit fires.
 *
 * Truncation: messages exceeding 4096 chars are truncated with a
 * "… (truncated)" suffix (spec: event-rendering R3).
 */

import type { Context } from 'telegraf';
import type { SSEEvent, MessageGroup } from './types.js';
import pino from 'pino';

const logger = pino({ name: 'messageRenderer' });

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Per-chat message group: tracks Telegram message IDs and last edit time. */
const groups = new Map<number, MessageGroup>();

/** Per-chat accumulator buffers for delta-based event types. */
const thoughtBuffers = new Map<number, string>();
const answerBuffers = new Map<number, string>();

/** Per-chat pending throttle timer. */
const timers = new Map<number, ReturnType<typeof setTimeout>>();

const THROTTLE_MS = 500;
const MAX_MESSAGE_LENGTH = 4096;
const TRUNCATED_SUFFIX = '… (truncated)';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Truncate `text` to fit within Telegram's 4096-char message limit. */
function truncate(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  return text.slice(0, MAX_MESSAGE_LENGTH - TRUNCATED_SUFFIX.length) + TRUNCATED_SUFFIX;
}

/**
 * Safely edit a Telegram text message, catching 400 Bad Request
 * (message deleted / identical content) gracefully.
 */
async function safeEditText(
  ctx: Context,
  chatId: number,
  messageId: number | undefined,
  text: string,
): Promise<void> {
  if (messageId === undefined) return;

  try {
    await ctx.telegram.editMessageText(chatId, messageId, undefined, truncate(text));
  } catch (err: unknown) {
    const httpErr = err as { response?: { error_code?: number } } | undefined;
    if (httpErr?.response?.error_code === 400) {
      logger.debug({ messageId, chatId }, 'Edit 400 — message likely deleted');
      return;
    }
    // Other errors bubble up
    throw err;
  }
}

/**
 * Flush the accumulated buffer for a specific message ID: perform the actual
 * Telegram edit and reset timer state.
 */
async function flushEdit(
  ctx: Context,
  chatId: number,
  messageId: number | undefined,
  buffer: string,
): Promise<void> {
  await safeEditText(ctx, chatId, messageId, buffer);

  const group = groups.get(chatId);
  if (group) {
    group.lastEditTime = Date.now();
  }
  timers.delete(chatId);
}

/**
 * Schedule a throttled edit. If a timer already exists, it is replaced —
 * only the latest buffer content survives (last-write-wins).
 */
function scheduleEdit(
  ctx: Context,
  chatId: number,
  messageId: number | undefined,
  bufferKey: Map<number, string>,
): void {
  // Clear any existing timer — last-write-wins
  const existing = timers.get(chatId);
  if (existing) clearTimeout(existing);

  const group = groups.get(chatId);
  if (!group) return;

  const elapsed = Date.now() - group.lastEditTime;
  if (elapsed >= THROTTLE_MS) {
    // Enough time passed — edit immediately
    const buffer = bufferKey.get(chatId) ?? '';
    flushEdit(ctx, chatId, messageId, buffer).catch((err: unknown) => {
      logger.error({ err, chatId }, 'flushEdit failed');
    });
    return;
  }

  // Schedule future edit
  const delay = THROTTLE_MS - elapsed;
  const timer = setTimeout(() => {
    const buffer = bufferKey.get(chatId) ?? '';
    flushEdit(ctx, chatId, messageId, buffer).catch((err: unknown) => {
      logger.error({ err, chatId }, 'scheduled flushEdit failed');
    });
  }, delay);

  timers.set(chatId, timer);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a single SSE event by editing or creating Telegram messages.
 *
 * First call per chat sends an initial "⏳ Procesando…" placeholder that
 * doubles as the thought message. Subsequent reasoning/text deltas edit
 * their respective messages with 500ms throttle. Tool events create/edit
 * a separate tool message without throttling.
 */
export async function renderEvent(
  ctx: Context,
  event: SSEEvent,
  _sessionId: string,
): Promise<void> {
  const chatId = ctx.chat!.id;

  // Lazily initialise group + send initial placeholder on first event
  let group = groups.get(chatId);
  if (!group) {
    const msg = await ctx.reply('⏳ Procesando…');
    group = {
      thoughtMsgId: msg.message_id,
      lastEditTime: Date.now(),
    };
    groups.set(chatId, group);
  }

  switch (event.type) {
    // ── Reasoning delta ────────────────────────────────────────────────
    case 'session.next.reasoning.delta': {
      const prev = thoughtBuffers.get(chatId) ?? '';
      thoughtBuffers.set(chatId, prev + event.delta);
      scheduleEdit(ctx, chatId, group.thoughtMsgId, thoughtBuffers);
      break;
    }

    // ── Tool call ──────────────────────────────────────────────────────
    case 'session.next.tool_call': {
      // Send a new tool message (replaces any previous tool message)
      const toolText = `🔧 ${event.tool}\n\`\`\`\n${JSON.stringify(event.input, null, 2)}\n\`\`\``;
      const msg = await ctx.reply(truncate(toolText));
      group.toolMsgId = msg.message_id;
      group.lastEditTime = Date.now();
      break;
    }

    // ── Tool result ────────────────────────────────────────────────────
    case 'session.next.tool_result': {
      if (group.toolMsgId !== undefined) {
        const resultText = `✅ Resultado:\n${event.output}`;
        await safeEditText(ctx, chatId, group.toolMsgId, resultText);
        group.lastEditTime = Date.now();
      }
      break;
    }

    // ── Text delta (final answer) ──────────────────────────────────────
    case 'session.next.text.delta': {
      const delta = (event as Extract<SSEEvent, { type: 'session.next.text.delta' }>).delta;
      const prev = answerBuffers.get(chatId) ?? '';

      // On first text delta, send a new answer message
      if (prev.length === 0 && group.finalMsgId === undefined) {
        const msg = await ctx.reply(delta);
        group.finalMsgId = msg.message_id;
        answerBuffers.set(chatId, delta);
        group.lastEditTime = Date.now();
        return;
      }

      answerBuffers.set(chatId, prev + delta);
      scheduleEdit(ctx, chatId, group.finalMsgId, answerBuffers);
      break;
    }

    // ── Done ───────────────────────────────────────────────────────────
    case 'session.next.done': {
      // Flush any pending edits before finalising
      const timer = timers.get(chatId);
      if (timer) {
        clearTimeout(timer);
        timers.delete(chatId);
      }

      // Final flush of thought and answer buffers
      const thoughtBuf = thoughtBuffers.get(chatId);
      if (thoughtBuf && group.thoughtMsgId !== undefined) {
        await safeEditText(ctx, chatId, group.thoughtMsgId, thoughtBuf)
          .catch(() => {});
      }

      const answerBuf = answerBuffers.get(chatId);
      if (answerBuf && group.finalMsgId !== undefined) {
        await safeEditText(ctx, chatId, group.finalMsgId, answerBuf)
          .catch(() => {});
      }

      // Clean up rendering state for this chat
      groups.delete(chatId);
      thoughtBuffers.delete(chatId);
      answerBuffers.delete(chatId);
      break;
    }

    // ── Permission & question — no rendering here; interactionHandler does it ──
    case 'permission.asked':
    case 'question.asked':
      // Handled directly by bot.ts → interactionHandler
      break;

    // ── Unknown event ──────────────────────────────────────────────────
    default:
      logger.warn({ type: event.type }, 'Unknown SSE event in renderEvent');
      break;
  }
}
