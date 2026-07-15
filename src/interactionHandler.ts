/**
 * Interaction handler — inline keyboard flows for permission approvals and
 * question answers.
 *
 * Permission flow (spec: user-interaction R1, R3):
 *   1. Receive `permission.asked` event → render tool details + Approve/Deny.
 *   2. User taps a button → bot.ts action handler resolves via
 *      `kiloClient.permission.resolve()` then deletes the interaction message.
 *
 * Question flow (spec: user-interaction R2, R4):
 *   1. Receive `question.asked` event → render question + one button per option.
 *   2. User taps a button → bot.ts action handler calls
 *      `kiloClient.question.answer()` then deletes the interaction message.
 */

import { Context, Markup } from 'telegraf';
import type { SSEEvent } from './types.js';
import pino from 'pino';

const logger = pino({ name: 'interactionHandler' });

// ---------------------------------------------------------------------------
// Narrowed event types (subsets of SSEEvent)
// ---------------------------------------------------------------------------

type PermissionEvent = Extract<SSEEvent, { type: 'permission.asked' }>;
type QuestionEvent = Extract<SSEEvent, { type: 'question.asked' }>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a permission request with Approve / Deny inline buttons.
 *
 * Callback data format:
 *   - approve:{permissionId}
 *   - deny:{permissionId}
 *
 * Resolution (approve/deny) and message deletion are handled by bot.ts
 * action handlers. This function only renders the message.
 */
export async function handlePermission(
  ctx: Context,
  event: PermissionEvent,
): Promise<void> {
  const { tool, input, permissionId } = event;

  logger.info({ permissionId, tool }, 'Rendering permission request');

  const message = [
    `🔧 La herramienta **${tool}** quiere ejecutarse con:`,
    '```json',
    JSON.stringify(input, null, 2),
    '```',
    '¿Permitir?',
  ].join('\n');

  await ctx.reply(message, {
    ...Markup.inlineKeyboard([
      Markup.button.callback('✅ Aprobar', `approve:${permissionId}`),
      Markup.button.callback('❌ Denegar', `deny:${permissionId}`),
    ]),
    parse_mode: 'Markdown',
  });
}

/**
 * Render a question with one inline button per option.
 *
 * Callback data format:
 *   - answer:{questionId}:{optionText}
 *
 * If `options` is empty or missing, no buttons are rendered — just the
 * question text is shown.
 */
export async function handleQuestion(
  ctx: Context,
  event: QuestionEvent,
): Promise<void> {
  const { question, options, questionId } = event;

  logger.info({ questionId }, 'Rendering question');

  if (!options || options.length === 0) {
    await ctx.reply(`❓ ${question}`);
    return;
  }

  const buttons = options.map((opt) =>
    Markup.button.callback(opt, `answer:${questionId}:${opt}`),
  );

  await ctx.reply(`❓ ${question}`, Markup.inlineKeyboard(buttons));
}
