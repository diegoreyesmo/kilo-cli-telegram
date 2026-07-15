# Delta Specs: implementa el plan inicial

Five new capability specs for the Kilo Code Telegram bot.

## bot-entrypoint

| # | Requirement | Strength |
|---|-------------|----------|
| R1 | Startup with `TELEGRAM_BOT_TOKEN`, launch Telegraf polling | MUST |
| R2 | `/start`: create session, reply welcome message | SHALL |
| R3 | `/new`: reset session. `/stop`: cancel current prompt via abort | SHALL |
| R4 | Route `approve:`, `deny:`, `answer:` callback prefixes to interaction handlers | SHALL |

**Scenario**: `/start` creates a Kilo session if none exists. **Scenario**: `/stop` during processing aborts and sets idle. **Scenario**: missing token exits with error.

## kilo-adapter

| # | Requirement | Strength |
|---|-------------|----------|
| R1 | Connect to Kilo server at `KILO_SERVER_URL` (default port 4096) | MUST |
| R2 | Singleton `createKiloClient()` — reuse existing instance | SHALL |
| R3 | SSE subscription filtered by `sessionId` with onEvent/onError callbacks | SHALL |
| R4 | Return cleanup function per subscription to close EventSource | SHOULD |

**Scenario**: Events with matching `sessionId` trigger `onEvent`; others are ignored. **Scenario**: Server unavailable throws descriptive error logged via pino.

## session-state

| # | Requirement | Strength |
|---|-------------|----------|
| R1 | In-memory `Map<chatId, SessionState>` with sessionId, status, project, model, activePromptId, abortController | MUST |
| R2 | `getOrCreateSession(chatId)`: create on first use, return existing on subsequent calls | SHALL |
| R3 | `updateSession(chatId, partial)`: merge partial state updates | SHALL |
| R4 | `cancelCurrentPrompt(chatId)`: abort via AbortController, close SSE, set idle | MUST |

**Status flow**: `idle` → `processing` on prompt → `waiting_interaction` on permission/question → `idle` on done/cancel. **Scenario**: new message during processing cancels prior prompt and starts new one.

## event-rendering

| # | Requirement | Strength |
|---|-------------|----------|
| R1 | Map SSE events to messages: reasoning→💭thought, tool_call→🔧tool, text.delta→accumulated answer, done→finalize | MUST |
| R2 | Throttle edits to ≥500ms per chat; accumulate deltas in buffer between edits | SHALL |
| R3 | Truncate message content at 4096 chars with `… (truncated)` suffix | MUST |
| R4 | Per-chat `MessageGroup` tracks thought/tool/final message IDs and lastEditTime | SHALL |

**Scenario**: Rapid text deltas at T+0, T+200ms → single edit at T+500ms with all accumulated text. **Scenario**: 5000-char answer is truncated to 4096.

## user-interaction

| # | Requirement | Strength |
|---|-------------|----------|
| R1 | `permission.asked`: render tool name + input + Approve/Deny inline buttons (`approve:{id}`, `deny:{id}`) | MUST |
| R2 | `question.asked`: render question + one button per option (`answer:{qid}:{option}`) | MUST |
| R3 | Approve/deny resolves via `kiloClient.permission.resolve()` then deletes message | SHALL |
| R4 | Answer resolves via `kiloClient.question.answer()` then deletes message | SHALL |

**Scenario**: Permission approve tap resolves and returns to `processing`. **Scenario**: Question option tap sends answer and deletes question message.

## Key Decisions

- All sessions in-memory — lost on restart (documented limitation)
- Single `@kilocode/sdk` client instance per process
- Notification-style rendering: progressive single-message editing, not multi-message log
- `AbortController` per session for prompt cancellation
- Callback data payloads carry IDs inline (`approve:` prefix) rather than state storage
