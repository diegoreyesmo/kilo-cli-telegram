# session-state Specification

In-memory session state management per Telegram chat, including creation, retrieval, status tracking, and prompt cancellation.

## Requirements

| # | Requirement | Strength |
|---|-------------|----------|
| R1 | System MUST maintain an in-memory `Map<chatId, SessionState>` mapping each chat to its Kilo Code session | MUST |
| R2 | System SHALL create a new Kilo Code session on first chat interaction via `getOrCreateSession(chatId)` | SHALL |
| R3 | System SHALL support updating session fields (status, activePromptId) via `updateSession(chatId, partial)` | SHALL |
| R4 | System MUST enable prompt cancellation via `AbortController` stored in SessionState | MUST |

### R1: Session creation

#### Scenario: First message from chat

- GIVEN chat `123` has no entry in the sessions map
- WHEN `getOrCreateSession(123)` is called
- THEN a new Kilo Code session is created via the SDK
- AND a `SessionState` entry is stored with `status: 'idle'`, a `sessionId`, and a new `AbortController`

#### Scenario: Returning chat

- GIVEN chat `123` already has a `SessionState` with `status: 'idle'`
- WHEN `getOrCreateSession(123)` is called
- THEN the existing state is returned without creating a new session

### R2: Status transitions

| Status | Meaning |
|--------|---------|
| `idle` | No active prompt |
| `processing` | Prompt submitted, streaming SSE |
| `waiting_interaction` | Awaiting user response to permission/question |

#### Scenario: Prompt starts

- GIVEN a session with `status: 'idle'`
- WHEN `client.session.prompt()` is called
- THEN `status` transitions to `'processing'`

#### Scenario: Permission requested

- GIVEN a session in `'processing'` status
- WHEN a `permission.asked` SSE event arrives
- THEN `status` transitions to `'waiting_interaction'`

### R3: Prompt cancellation

#### Scenario: Cancel during processing

- GIVEN a session in `'processing'` status with an active `AbortController`
- WHEN `cancelCurrentPrompt(chatId)` is called
- THEN the `AbortController` signals abort
- AND the SSE subscription is closed
- AND `status` returns to `'idle'`

#### Scenario: New message while processing

- GIVEN a session in `'processing'` status
- WHEN a new user message is received
- THEN the current prompt is cancelled via abort
- AND a new prompt begins with the new message text
