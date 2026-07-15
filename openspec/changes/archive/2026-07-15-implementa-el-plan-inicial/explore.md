## Exploration: implementa el plan inicial

### Current State

The project `kilo-cli-telegram` is a **greenfield TypeScript/Node.js project** — no source code has been written yet. The only committed file is `README.md`. The working tree contains three untracked artifacts:

- `plan_inicial.md` — a detailed 11-section implementation plan (source of truth for "el plan inicial")
- `openspec/` — SDD scaffolding (config.yaml, empty specs/, changes/archive/)
- `.atl/` — skill registry

**What the project is**: A Telegram bot that bridges user chat messages to Kilo Code (an AI coding assistant CLI). The bot receives messages, forwards them to a local Kilo Code server, and streams back real-time updates: reasoning/thought chain, tool calls, tool results, and final answers. It also handles interactive events (permission requests, questions from the AI) via Telegram inline buttons.

**Architecture** (from `plan_inicial.md` and `openspec/config.yaml`):
- Single-process bot, no database
- State: in-memory `Map<chatId, SessionState>`
- Event streaming: SSE from local Kilo Code server (port 4096)
- Telemetry: pino structured logging

**Key dependencies** (planned, not yet installed):
- `telegraf` — Telegram Bot framework
- `@kilocode/sdk` — Kilo Code client SDK
- `dotenv` — environment variable loading
- `pino` — structured logging
- `typescript`, `@types/node`, `ts-node` — dev dependencies

**Testing**: No test runner configured. `openspec/config.yaml` explicitly states `tdd: false` with `test_command: "echo 'No test runner configured yet'"`.

### Affected Areas

This is a greenfield implementation — ALL planned source files will be created from scratch:

- `src/bot.ts` — Bot entry point, Telegraf configuration, callback handlers for approve/deny/answer actions
- `src/kiloClient.ts` — Kilo SDK adapter: server init/client creation, SSE event subscription via EventSource
- `src/sessionManager.ts` — Session lifecycle per `chatId`: create, retrieve, update, cancel (AbortController)
- `src/messageRenderer.ts` — Telegram message rendering with 500ms throttle: thought messages, tool call display, final answer accumulation, message editing
- `src/interactionHandler.ts` — Inline button rendering for `permission.asked` (approve/deny) and `question.asked` (option buttons)
- `src/types.ts` — Shared TypeScript types: SessionState, MessageGroup, event types
- `package.json` — Project metadata, scripts, dependencies
- `tsconfig.json` — TypeScript configuration (strict mode per config.yaml)
- `.env.example` — Environment variable template (TELEGRAM_BOT_TOKEN, KILO_SERVER_URL, etc.)

### Approaches

#### Approach: Single-phase greenfield implementation (RECOMMENDED)

Build the entire bot in one phase following `plan_inicial.md` section by section. The plan already provides code snippets and architectural decisions for all 6 source files.

- **Pros**: 
  - Plan is complete and detailed — sections 1-11 cover every aspect
  - All files are standalone with clear interfaces — low risk of architectural issues
  - Single delivery unit keeps the review surface manageable
  - Plan has been validated against real Kilo SDK API (the "Plan corregido" section documents corrections from an earlier draft)
- **Cons**: 
  - No incremental deliverable — all-or-nothing implementation
  - No test infrastructure yet — validation is manual only
- **Effort**: Medium

#### Approach: Phased implementation with testing first

Set up TypeScript config, test runner (vitest/jest), and testing patterns first, then implement modules incrementally with tests.

- **Pros**: 
  - Better code quality guarantees
  - Easier to onboard future contributors
  - Incremental delivery possible
- **Cons**: 
  - Significant additional effort to set up test infrastructure for a bot that interfaces with external services (Telegram API, Kilo SSE)
  - Many modules require mocking Telegraf/Kilo SDK — testing may not catch integration issues
  - `openspec/config.yaml` explicitly sets `tdd: false`
- **Effort**: High

### Recommendation

The **single-phase greenfield implementation** approach. The `plan_inicial.md` is comprehensive, already validated against the real Kilo SDK API, and the codebase is empty — there are no existing patterns to refactor or compatibility constraints to honor. Setting up test infrastructure at this stage adds friction without proportional value given that: (a) the config explicitly disables TDD, (b) most behavior is I/O-bound with external services that need integration/staging testing, and (c) the plan provides implementation-level detail down to specific event types and code structures.

### Risks

- **SSE event contract mismatch**: The plan references event types (`session.next.text.delta`, `permission.asked`, etc.) based on Kilo SDK documentation. If the actual SDK diverges, the event handling will break. **Mitigation**: implement SSE event handling with defensive type checking and unknown event logging.
- **Telegram API rate limits**: Message editing throttle (500ms) is planned, but Telegram has a ~30 messages/second global limit and edit-specific limits. Rapid tool call streams could cause dropped edits. **Mitigation**: implement a message edit queue with backpressure.
- **No `@kilocode/sdk` package available**: The plan assumes `@kilocode/sdk` exposes `createKilo()`, `createKiloClient()`, and SSE endpoints. If this package doesn't exist publicly or has a different API, the entire `kiloClient.ts` module design changes. **Mitigation**: verify SDK availability and API before implementation.
- **In-memory state loss**: Sessions are stored in a `Map` — bot restart loses all state. This is acceptable per the plan's stated scope but should be documented as a known limitation.

### Ready for Proposal

Yes — the plan is complete, the codebase is empty, and the implementation path is well-defined. Proceed to `sdd-propose` to formalize the scope and approach for this change.
