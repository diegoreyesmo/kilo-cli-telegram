# Tasks: Implementa el Plan Inicial

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~560 (9 new files, all greenfield) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 → PR 2 (stacked to main) |
| Delivery strategy | force-chained |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Types, config, kiloClient, sessionManager | PR 1 (~260 lines) | Foundation + core infra; independently compilable |
| 2 | messageRenderer, interactionHandler, bot.ts | PR 2 (~300 lines) | Rendering + wiring; depends on PR 1 types |

---

## PR 1 — Foundation & Core Infrastructure

### Phase 1: Project Setup (bot-entrypoint R1, kilo-adapter R1-R2)

- [x] 1.1 Create `package.json` with dependencies: `telegraf`, `dotenv`, `pino`, `eventsource`; devDeps: `typescript`, `@types/node`, `ts-node`
- [x] 1.2 Create `tsconfig.json` with strict mode, `target: ES2022`, `module: NodeNext`, `outDir: dist`
- [x] 1.3 Create `.env.example` with `TELEGRAM_BOT_TOKEN`, `KILO_SERVER_URL`, `KILO_CONFIG_PATH`, `LOG_LEVEL`

### Phase 2: Type Definitions (all specs cross-cutting)

- [x] 2.1 Create `src/types.ts`: `SessionState`, `SSEEvent`, `MessageGroup`, `KiloConfig` interfaces matching design's session state model

### Phase 3: Kilo SDK Adapter (kilo-adapter R1-R4)

- [x] 3.1 Create `src/kiloClient.ts` — `initKilo()` with `createKilo()` from `@kilocode/sdk`, singleton pattern via module-level variable
- [x] 3.2 Add `getKiloClient()` — returns singleton or creates via `createKiloClient({ baseUrl })` fallback
- [x] 3.3 Add `subscribeToSessionEvents(sessionId, onEvent, onError)` — EventSource on `{KILO_SERVER_URL}/global/event`, filter by `sessionId`, return cleanup fn (spec: kilo-adapter R3-R4)

### Phase 4: Session Manager (session-state R1-R4)

- [x] 4.1 Create `src/sessionManager.ts` — in-memory `Map<chatId, SessionState>` with status flow: `idle → processing → waiting_interaction → idle`
- [x] 4.2 Implement `getOrCreateSession(chatId)` — create Kilo session on first use, return existing on subsequent calls (spec: session-state R2)
- [x] 4.3 Implement `updateSession(chatId, partial)`, `getSession(chatId)` (spec: session-state R3)
- [x] 4.4 Implement `cancelCurrentPrompt(chatId)` — abort via `AbortController`, close SSE cleanup, set status idle (spec: session-state R4)

---

## PR 2 — Rendering, Interaction & Bot Wiring

### Phase 5: Message Renderer (event-rendering R1-R4)

- [x] 5.1 Create `src/messageRenderer.ts` — `MessageGroup` per-chat tracking: `thoughtMsgId`, `toolMsgId`, `finalMsgId`, `lastEditTime`
- [x] 5.2 Implement `renderEvent(ctx, event, sessionId)` — switch on SSE event type: reasoning→thought, tool_call→tool, tool_result→tool update, text.delta→accumulate, done→finalize (spec: event-rendering R1)
- [x] 5.3 Implement 500ms throttle: buffer deltas, schedule `setTimeout`, last-write-wins (spec: event-rendering R2)
- [x] 5.4 Implement 4096-char truncation with `… (truncated)` suffix; catch `400 Bad Request` on edit gracefully (spec: event-rendering R3-R4)

### Phase 6: Interaction Handler (user-interaction R1-R4)

- [x] 6.1 Create `src/interactionHandler.ts` — `handlePermission(ctx, event)`: render tool name + input + Approve/Deny inline buttons (`approve:{id}`, `deny:{id}`) (spec: user-interaction R1)
- [x] 6.2 Implement `handleQuestion(ctx, event)`: render question + one button per option (`answer:{qid}:{option}`) (spec: user-interaction R2)
- [x] 6.3 Wire resolve calls: `kiloClient.permission.resolve()` on approve/deny, `kiloClient.question.answer()` on answer, delete interaction message after resolve (spec: user-interaction R3-R4)

### Phase 7: Bot Entrypoint & Wiring (bot-entrypoint R1-R4)

- [x] 7.1 Create `src/bot.ts` — Telegraf init with `TELEGRAM_BOT_TOKEN`, global `bot.catch()` error handler logging via pino (spec: bot-entrypoint R1)
- [x] 7.2 Implement `/start` command: `getOrCreateSession`, reply welcome message; `/new`: reset session; `/stop`: `cancelCurrentPrompt` (spec: bot-entrypoint R2-R3)
- [x] 7.3 Implement `bot.on('text')`: `cancelCurrentPrompt` → `getOrCreateSession` → `kiloClient.sendPrompt` → `subscribeToSessionEvents` with `renderEvent` callback
- [x] 7.4 Wire action routers: `bot.action(/approve:(.+)/)`, `bot.action(/deny:(.+)/)`, `bot.action(/answer:(.+):(.+)/)` → delegate to `interactionHandler` (spec: bot-entrypoint R4)
- [x] 7.5 Call `bot.launch()`, enable graceful stop on SIGINT/SIGTERM, log startup message

---

## Post-Implementation Verification

- [ ] Run `npm install && npx tsc --noEmit` — typecheck passes (verify build_command)
- [ ] Manual smoke test: `/start` creates session, text message triggers SSE rendering, `/stop` cancels
- [ ] Manual smoke test: `permission.asked` renders Approve/Deny buttons, tap resolves
- [ ] Manual smoke test: `question.asked` renders option buttons, tap sends answer
