# Proposal: Implementa el Plan Inicial

## Intent

Build a Telegram bot that bridges user chat messages to a local Kilo Code AI assistant. Users send natural language prompts via Telegram; the bot forwards them to Kilo Code and streams back real-time updates — reasoning, tool calls, tool results, and final answers — with interactive inline buttons for permission requests and questions.

## Scope

### In Scope
- Bot initialization with Telegraf (`src/bot.ts`)
- Kilo SDK adapter for SSE event streaming (`src/kiloClient.ts`)
- Per-chat session management in-memory (`src/sessionManager.ts`)
- Event-to-message rendering with 500ms edit throttle (`src/messageRenderer.ts`)
- Inline button interaction handling — approve/deny permissions, answer questions (`src/interactionHandler.ts`)
- Shared TypeScript types (`src/types.ts`)
- Project scaffolding: `package.json`, `tsconfig.json`, `.env.example`

### Out of Scope
- Database persistence — sessions are in-memory, lost on restart
- Authentication beyond the Telegram bot token
- Multi-project support — single hardcoded project per session
- Test infrastructure — `tdd: false` per config
- Dockerization or deployment automation

## Capabilities

> Capabilities contract for sdd-spec. `openspec/specs/` is empty — all are new.

### New Capabilities
- `bot-entrypoint`: Bot startup, Telegraf wiring, `/start` command, callback action routing
- `kilo-adapter`: Kilo Code server connection, SSE event subscription, client session API
- `session-state`: In-memory Map<chatId, SessionState> with create/retrieve/update/cancel/abort
- `event-rendering`: SSE events → Telegram message updates with 500ms throttle, accumulator, and 4096-char limit
- `user-interaction`: Inline keyboard rendering for permission.asked (approve/deny) and question.asked (option buttons)

### Modified Capabilities
None — greenfield project with no existing specs.

## Approach

Single-phase greenfield implementation following `plan_inicial.md` sections 1–11. All six source files are standalone with clear interfaces. The plan has been validated against the real Kilo SDK API (see "Plan corregido" summary table). Implementation order: scaffolding → types → kiloClient → sessionManager → messageRenderer → interactionHandler → bot.ts.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/` | New | All source files created from scratch |
| `package.json` | New | Dependencies: telegraf, @kilocode/sdk, dotenv, pino |
| `tsconfig.json` | New | TypeScript strict mode |
| `.env.example` | New | Environment variable template |
| `README.md` | Modified | Update with setup and run instructions |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `@kilocode/sdk` API mismatch | Medium | Verify package availability before implementation; fallback to direct HTTP SSE client |
| SSE event contract divergence | Medium | Defensive type checking; log unknown event types |
| Telegram rate limits on rapid edits | Low | Message edit queue with 500ms throttle; batch accumulator |
| In-memory session loss on restart | Low | Document as known limitation; future: optional file-based persistence |

## Rollback Plan

Revert all commits on the feature branch. No database migrations to undo. If `@kilocode/sdk` is unavailable, fall back to direct HTTP/SSE client wrapped in `kiloClient.ts` without changing the rest of the architecture.

## Dependencies

- Local Kilo Code CLI running on port 4096 (`kilo serve` or equivalent)
- `@kilocode/sdk` npm package (to be verified — may need HTTP fallback)
- Valid Telegram bot token from @BotFather

## Success Criteria

- [ ] Bot starts and responds to `/start` without errors
- [ ] Text message triggers a Kilo Code session prompt
- [ ] SSE events render as real-time Telegram message updates (thought, tools, answer)
- [ ] Permission inline buttons appear and resolve correctly (approve/deny)
- [ ] Question inline buttons appear and answers route correctly
- [ ] `npx tsc --noEmit` passes with strict mode
- [ ] New message during processing cancels prior prompt (AbortController)
