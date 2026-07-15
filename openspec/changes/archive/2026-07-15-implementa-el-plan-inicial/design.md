# Design: Implementa el Plan Inicial

## Technical Approach

Single-process Node.js bot using Telegraf framework. Six modules with unidirectional data flow: `bot.ts` receives Telegram messages → `kiloClient.ts` translates to Kilo SDK calls → SSE stream filtered by `sessionId` → `messageRenderer.ts` throttles and edits Telegram messages → `interactionHandler.ts` manages inline button flows. `sessionManager.ts` provides per-chat state with `AbortController` for cancellation. In-memory `Map<number, SessionState>` — no persistence layer.

## Architecture

```
                   ┌─────────────┐     ┌─────────────────┐
Telegram ──HTTP──→ │   bot.ts    │────→│ sessionManager   │
                   │ (Telegraf)  │←────│ Map<chatId,State>│
                   └──────┬──────┘     └────────┬────────┘
                          │ create/prompt       │ getSession
                   ┌──────▼──────┐              │
                   │ kiloClient  │←─────────────┘
                   │ @kilocode/sdk│
                   │ + SSE filter│
                   └──────┬──────┘
                          │ EventSource SSE stream
                   ┌──────▼──────────┐
                   │ messageRenderer  │────→ Telegram editMessage API
                   │ 500ms throttle   │
                   │ edit queue       │
                   └──────┬──────────┘
                          │ permission.asked / question.asked
                   ┌──────▼───────────┐
                   │ interactionHandler│────→ inline_keyboard reply
                   └──────────────────┘
```

## Data Flow — Full Prompt Sequence

```
User sends "fix auth" to Telegram
  │
  ▼
bot.ts: ctx.on('text') fires
  │ 1. cancelCurrentPrompt(chatId) — aborts prior SSE
  │ 2. getOrCreateSession(chatId) — new Kilo session if needed
  │ 3. kiloClient.sendPrompt(session, userMessage)
  │ 4. kiloClient.subscribeToSSE(sessionId, onEvent)
  │
  ▼
SSE stream emits events (described below)
  │ messageRenderer.renderEvent() called per event
  │    ├─ reasoning.delta  → edit "thought" message
  │    ├─ tool_call        → send new "tool executing" message
  │    ├─ tool_result      → edit tool message with output
  │    ├─ text.delta       → accumulate & edit "answer" message
  │    ├─ permission.asked → delegate to interactionHandler
  │    ├─ question.asked   → delegate to interactionHandler
  │    └─ done             → finalize, set status=idle
  │
  ▼
Telegram client sees real-time message updates
```

## Architecture Decisions

| Decision | Options | Tradeoff | Choice |
|----------|---------|----------|--------|
| Bot framework | Telegraf vs grammY vs bare Telegram API | Telegraf has mature middleware, built-in session context, large ecosystem. grammY is newer but less tested. Bare API means reinventing routing. | **Telegraf** — proven, plan_inicial.md uses it, minimal friction |
| Session storage | In-memory Map vs Redis vs SQLite | Redis/SQLite require deps and deployment complexity. Map is zero-config but loses state on restart. Scope explicitly excludes persistence. | **In-memory Map** — matches scope, zero deps, acceptable for MVP |
| SSE client | EventSource API vs eventsource polyfill vs fetch streaming | EventSource is browser-only in older Node. Node 22 has native WebSocket/EventSource support, eventsource polyfill adds no native noise. | **`eventsource` polyfill** — works across Node versions, used in plan_inicial.md |
| Throttle strategy | setTimeout-based buffer vs Promise queue | Buffer is simple but can burst. Queue provides backpressure. 500ms interval is low-risk given SSE event rate. | **setTimeout buffer with last-write-wins** — simple, bounded by Telegram's 4096-char limit |
| Cancel on new msg | AbortController per session vs ignore concurrent msgs | Ignoring leads to stale edits. AbortController cleanly terminates SSE connection. | **AbortController** — matches plan, clean lifecycle |

## Session State Model

```typescript
interface SessionState {
  sessionId: string;           // Kilo session UUID
  project: string;             // project path (single, hardcoded)
  model: string;               // model identifier
  history: Array<{role: string; content: string}>;
  activePromptId?: string;
  status: 'idle' | 'processing' | 'waiting_interaction';
  abortController?: AbortController;  // kills SSE on new message
}
```

Lifecycle: **idle** (no prompt) → **processing** (SSE streaming) → **idle** (done) or **waiting_interaction** (permission/question). `cancelCurrentPrompt` aborts SSE, sets status to idle, clears abortController.

## SSE Event Handling Strategy

| Event Type | Action | Defensive Check |
|------------|--------|-----------------|
| `session.next.reasoning.delta` | Append to thought message, edit in place | `typeof delta === 'string'` |
| `session.next.tool_call` | Send new message: `🔧 {tool}\n{input}` | `tool: string, input: object` |
| `session.next.tool_result` | Edit tool message with `✅ Result:\n{output}` | `output: string` |
| `session.next.text.delta` | Accumulate buffer, throttle-edit answer message | `typeof delta === 'string'` |
| `session.next.done` | Finalize; set status=idle; close SSE | None |
| `permission.asked` | Delegate to interactionHandler (inline buttons) | `permissionId: string, tool: string` |
| `question.asked` | Delegate to interactionHandler (option buttons) | `questionId: string, question: string` |
| Unknown | `logger.warn({type: event.type}, 'unknown event')` | No crash |

SSE URL: `{KILO_SERVER_URL}/global/event`. Filter by `data.sessionId === sessionId`. Parse with `try/catch` — malformed JSON logs warning, skips event.

## Message Rendering Pipeline

1. **Initial state**: `MessageGroup` maps `chatId → { thoughtMsgId, toolMsgId, finalMsgId, accumulator, lastEditTime }`
2. **First event**: sends initial `⏳ Procesando...` message, sets `thoughtMsgId`
3. **Per event**: checks `Date.now() - lastEditTime >= 500ms`. If too soon, overwrites accumulator buffer and schedules `setTimeout`. If ready, edits the message via `ctx.telegram.editMessageText()`
4. **4096-char limit**: messages truncated with `(truncated)` suffix before calling Telegram API
5. **Edit failure**: catches `400 Bad Request` (message deleted, no change) — logs debug, continues. Other errors bubble to `onError`

## Error Handling Strategy

| Module | Errors | Strategy |
|--------|--------|----------|
| `bot.ts` | Bot polling failures, invalid token | `bot.catch()` global handler, log with pino, set status=none |
| `kiloClient.ts` | SSE connection lost, SDK unavailable | `EventSource.onerror` → log, close connection, set status=idle; `createKiloClient()` throws if server unreachable → caught at bot level |
| `sessionManager.ts` | Session creation failure (SDK error) | Try/catch in `getOrCreateSession`, reply to user: "Error: no pude crear sesión con Kilo Code" |
| `messageRenderer.ts` | Edit rejected (message deleted), throttle overflow | Catch `400` edits silently; catch others and log + notify user with error message |
| `interactionHandler.ts` | Stale callback (session gone), deny/approve failure | `answerCbQuery` with error text; catch `permission.resolve` failure → log |

## Module Interfaces

```typescript
// kiloClient.ts
initKilo(config: KiloConfig): Promise<{client, server}>
getKiloClient(): KiloClient
subscribeToSessionEvents(sessionId: string, onEvent: (event: SSEEvent) => void, onError: (err: Error) => void): () => void

// sessionManager.ts
getOrCreateSession(chatId: number): Promise<SessionState>
getSession(chatId: number): SessionState | undefined
updateSession(chatId: number, update: Partial<SessionState>): void
cancelCurrentPrompt(chatId: number): void

// messageRenderer.ts
renderEvent(ctx: Context, event: SSEEvent, sessionId: string): Promise<void>

// interactionHandler.ts
handlePermission(ctx: Context, event: PermissionEvent): Promise<void>
handleQuestion(ctx: Context, event: QuestionEvent): Promise<void>
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/types.ts` | Create | SessionState, SSEEvent, MessageGroup, KiloConfig type definitions |
| `src/kiloClient.ts` | Create | SDK init, SSE subscription with EventSource |
| `src/sessionManager.ts` | Create | Per-chat session lifecycle, AbortController |
| `src/messageRenderer.ts` | Create | Event→message pipeline, throttle, truncation |
| `src/interactionHandler.ts` | Create | Inline keyboard for permissions and questions |
| `src/bot.ts` | Create | Telegraf wiring, action routers, `/start` |
| `package.json` | Create | Dependencies and scripts |
| `tsconfig.json` | Create | TypeScript strict mode config |
| `.env.example` | Create | Environment variable template |

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Build | TypeScript compilation | `npx tsc --noEmit` — strict mode must pass |
| Integration | Manual end-to-end | Send test messages, verify SSE rendering, test approve/deny/answer buttons |
| Unit | N/A | `tdd: false` per config; no test runner configured |

## Open Questions

- [ ] Is `@kilocode/sdk` published? If not, `kiloClient.ts` MUST fall back to raw HTTP SSE client using `fetch` + `EventSource`.
- [ ] Confirm SSE URL path: plan says `/global/event` — verify against actual Kilo server routes.
