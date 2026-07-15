/**
 * Bot entrypoint — Telegraf wiring for the Kilo Code Telegram bot.
 *
 * Lifecycle:
 *   1. Startup: load env, init Telegraf, register middleware, launch.
 *   2. /start:  create or re-use a Kilo session, send welcome.
 *   3. /new:    reset session (cancel + delete + re-create).
 *   4. /stop:   cancel any running prompt, reset to idle.
 *   5. Text:    cancel → create session → send prompt → SSE → render events.
 *   6. Action:  route approve:/deny:/answer: callbacks to Kilo resolution.
 *   7. Shutdown: graceful stop on SIGINT / SIGTERM.
 */

import 'dotenv/config';

import { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import type { SSEEvent } from './types.js';
import { getKiloClient, subscribeToSessionEvents } from './kiloClient.js';
import {
  getOrCreateSession,
  getSession,
  updateSession,
  cancelCurrentPrompt,
  resetSession,
} from './sessionManager.js';
import { renderEvent } from './messageRenderer.js';
import { handlePermission, handleQuestion } from './interactionHandler.js';
import pino from 'pino';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const logger = pino({ name: 'bot' });

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  logger.fatal('TELEGRAM_BOT_TOKEN is not set. Exiting.');
  process.exit(1);
}

const bot = new Telegraf(token);

// ---------------------------------------------------------------------------
// Per-chat SSE cleanup registry
//
// Each active prompt has an SSE subscription whose cleanup function is stored
// here.  When a new message arrives (or /stop is called) the previous cleanup
// is invoked before creating a fresh subscription.
// ---------------------------------------------------------------------------

const sseCleanups = new Map<number, () => void>();

/** Tear down the SSE subscription for `chatId` and remove from registry. */
function closeSSE(chatId: number): void {
  const cleanup = sseCleanups.get(chatId);
  if (cleanup) {
    cleanup();
    sseCleanups.delete(chatId);
    logger.debug({ chatId }, 'SSE subscription closed');
  }
}

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

bot.catch((err: unknown, ctx: Context) => {
  const chatId = ctx.chat?.id ?? 'unknown';
  logger.error({ err, chatId, updateType: ctx.updateType }, 'Unhandled bot error');

  // Attempt to reset session state
  if (typeof chatId === 'number') {
    closeSSE(chatId);
    updateSession(chatId, { status: 'idle', activePromptId: undefined });
  }

  ctx.reply('⚠️ Ocurrió un error inesperado. Intentá de nuevo.').catch(() => {});
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** /start — create or re-use a session, send welcome. */
bot.command('start', async (ctx) => {
  const chatId = ctx.chat.id;

  try {
    const session = await getOrCreateSession(chatId);
    await ctx.reply(
      `👋 ¡Hola! Soy Kilo Code Bot.\nSesión: \`${session.sessionId}\`\nProyecto: \`${session.project}\`\nModelo: \`${session.model}\`\n\nEnviame un mensaje para empezar.`,
      { parse_mode: 'Markdown' },
    );
  } catch (err: unknown) {
    logger.error({ err, chatId }, '/start session creation failed');
    await ctx.reply('Error: no pude crear sesión con Kilo Code.');
  }
});

/** /new — reset and create a fresh session. */
bot.command('new', async (ctx) => {
  const chatId = ctx.chat.id;

  try {
    closeSSE(chatId);
    const session = await resetSession(chatId);
    logger.info({ chatId, sessionId: session.sessionId }, 'Session reset via /new');
    await ctx.reply(
      `🆕 Nueva sesión creada: \`${session.sessionId}\``,
      { parse_mode: 'Markdown' },
    );
  } catch (err: unknown) {
    logger.error({ err, chatId }, '/new reset failed');
    await ctx.reply('Error: no pude reiniciar la sesión.');
  }
});

/** /stop — cancel the running prompt and reset to idle. */
bot.command('stop', async (ctx) => {
  const chatId = ctx.chat.id;

  closeSSE(chatId);
  cancelCurrentPrompt(chatId);

  await ctx.reply('⏹️ Prompt cancelado. La sesión sigue activa — enviá otro mensaje cuando quieras.');
});

// ---------------------------------------------------------------------------
// Text message handler
// ---------------------------------------------------------------------------

bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const userText = (ctx.message as { text?: string }).text;
  if (!userText) return;

  logger.info({ chatId, textLength: userText.length }, 'Received text message');

  // 1. Cancel previous prompt + cleanup SSE
  closeSSE(chatId);
  cancelCurrentPrompt(chatId);

  // 2. Get or create session
  let session;
  try {
    session = await getOrCreateSession(chatId);
  } catch (err: unknown) {
    logger.error({ err, chatId }, 'Session creation failed in text handler');
    await ctx.reply('Error: no pude crear sesión con Kilo Code.');
    return;
  }

  // 3. Update status and send prompt
  updateSession(chatId, { status: 'processing' });

  const client = getKiloClient();

  let promptId: string;
  try {
    const result = await client.session.prompt(session.sessionId, {
      message: userText,
      history: session.history,
    });
    promptId = result.promptId;
  } catch (err: unknown) {
    logger.error({ err, chatId }, 'sendPrompt failed');
    updateSession(chatId, { status: 'idle' });
    await ctx.reply('Error: no pude enviar el mensaje a Kilo Code.');
    return;
  }

  updateSession(chatId, { activePromptId: promptId });

  // 4. Subscribe to SSE events
  const onEvent = (event: SSEEvent) => {
    // Render the event in Telegram
    renderEvent(ctx, event, session.sessionId).catch((err: unknown) => {
      logger.error({ err, chatId, eventType: event.type }, 'renderEvent failed');
    });

    // Update session state based on event type
    switch (event.type) {
      case 'session.next.done':
        closeSSE(chatId);
        updateSession(chatId, { status: 'idle', activePromptId: undefined });
        break;

      case 'permission.asked': {
        const permEvent = event as Extract<SSEEvent, { type: 'permission.asked' }>;
        updateSession(chatId, { status: 'waiting_interaction' });
        handlePermission(ctx, permEvent).catch((err: unknown) => {
          logger.error({ err, chatId }, 'handlePermission failed');
        });
        break;
      }

      case 'question.asked': {
        const qEvent = event as Extract<SSEEvent, { type: 'question.asked' }>;
        updateSession(chatId, { status: 'waiting_interaction' });
        handleQuestion(ctx, qEvent).catch((err: unknown) => {
          logger.error({ err, chatId }, 'handleQuestion failed');
        });
        break;
      }

      default:
        break;
    }
  };

  const onError = (err: Error) => {
    logger.error({ err, chatId }, 'SSE connection error');
    closeSSE(chatId);
    updateSession(chatId, { status: 'idle' });
    ctx.reply('⚠️ Se perdió la conexión con Kilo Code. Intentá de nuevo.').catch(() => {});
  };

  const cleanup = subscribeToSessionEvents(session.sessionId, onEvent, onError);
  sseCleanups.set(chatId, cleanup);
});

// ---------------------------------------------------------------------------
// Action (inline button) routers
// ---------------------------------------------------------------------------

/** Approve a permission request. */
bot.action(/^approve:(.+)$/, async (ctx) => {
  const permissionId = ctx.match[1];
  const chatId = ctx.chat!.id;

  logger.info({ permissionId, chatId }, 'Permission approved');

  try {
    const client = getKiloClient();
    await client.permission.resolve({ permissionId, approved: true });
    await ctx.answerCbQuery('✅ Aprobado');
  } catch (err: unknown) {
    logger.error({ err, permissionId }, 'approve resolve failed');
    await ctx.answerCbQuery('Error al aprobar');
    return;
  }

  // Return session to processing state
  const session = getSession(chatId);
  if (session) {
    updateSession(chatId, { status: 'processing' });
  }

  // Delete the interaction message
  try {
    await ctx.deleteMessage();
  } catch {
    // Message may already be gone — ignore
  }
});

/** Deny a permission request. */
bot.action(/^deny:(.+)$/, async (ctx) => {
  const permissionId = ctx.match[1];
  const chatId = ctx.chat!.id;

  logger.info({ permissionId, chatId }, 'Permission denied');

  try {
    const client = getKiloClient();
    await client.permission.resolve({ permissionId, approved: false });
    await ctx.answerCbQuery('❌ Denegado');
  } catch (err: unknown) {
    logger.error({ err, permissionId }, 'deny resolve failed');
    await ctx.answerCbQuery('Error al denegar');
    return;
  }

  // Return session to processing state
  const session = getSession(chatId);
  if (session) {
    updateSession(chatId, { status: 'processing' });
  }

  try {
    await ctx.deleteMessage();
  } catch {
    // Message may already be gone — ignore
  }
});

/** Answer a question. Uses non-greedy capture for questionId so options
 *  containing colons are handled correctly. */
bot.action(/^answer:(.+?):(.+)$/, async (ctx) => {
  const questionId = ctx.match[1];
  const answer = ctx.match[2];
  const chatId = ctx.chat!.id;

  logger.info({ questionId, answer, chatId }, 'Question answered');

  try {
    const client = getKiloClient();
    await client.question.answer({ questionId, answer });
    await ctx.answerCbQuery(`Respondiste: ${answer}`);
  } catch (err: unknown) {
    logger.error({ err, questionId }, 'question answer failed');
    await ctx.answerCbQuery('Error al responder');
    return;
  }

  // Return session to processing state
  const session = getSession(chatId);
  if (session) {
    updateSession(chatId, { status: 'processing' });
  }

  try {
    await ctx.deleteMessage();
  } catch {
    // Message may already be gone — ignore
  }
});

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

bot
  .launch()
  .then(() => {
    logger.info('Kilo Code Telegram bot started');
  })
  .catch((err: unknown) => {
    logger.fatal({ err }, 'Bot launch failed');
    process.exit(1);
  });

// Graceful stop on SIGINT / SIGTERM
let stopping = false;

function gracefulStop(signal: string) {
  if (stopping) return;
  stopping = true;

  logger.info({ signal }, 'Shutting down bot...');

  // Close all active SSE subscriptions
  for (const [chatId, cleanup] of sseCleanups) {
    cleanup();
    logger.debug({ chatId }, 'SSE closed during shutdown');
  }
  sseCleanups.clear();

  bot.stop(signal);
}

process.once('SIGINT', () => gracefulStop('SIGINT'));
process.once('SIGTERM', () => gracefulStop('SIGTERM'));
