# event-rendering Specification

Progressive rendering of SSE events as Telegram messages, with edit throttling and character limits.

## Requirements

| # | Requirement | Strength |
|---|-------------|----------|
| R1 | System MUST transform SSE event types into Telegram message updates | MUST |
| R2 | System SHALL throttle message edits to a minimum 500ms interval per chat | SHALL |
| R3 | System MUST enforce a 4096-character limit on Telegram message content | MUST |
| R4 | System SHALL maintain message references (thought, tool, final) per chat via `MessageGroup` | SHALL |

### Event-to-message mapping

| SSE Event Type | Rendering Behavior |
|----------------|-------------------|
| `session.next.reasoning.delta` | Append to thought message with `💭` prefix |
| `session.next.tool_call` | New message: `🔧 {toolName}` with tool input summary |
| `session.next.tool_result` | Edit tool message: append `✅ Result: {truncated output}` |
| `session.next.text.delta` | Accumulate deltas, edit final answer message |
| `session.next.done` | Finalize: stop editing, set session idle |

### R1: Progressive rendering

#### Scenario: Reasoning then tool then answer

- GIVEN an active SSE subscription for session `abc`
- WHEN events arrive in order: `reasoning.delta`, `tool_call`, `tool_result`, `text.delta`, `done`
- THEN the bot sends/edits 3 progressive messages: thought, tool status, final answer
- AND the final message contains the complete accumulated text deltas

### R2: 500ms throttle

#### Scenario: Rapid text deltas

- GIVEN a `text.delta` event arrives at T+0ms
- AND a second `text.delta` arrives at T+200ms
- WHEN the throttle guard evaluates
- THEN the bot accumulates deltas and issues a single edit at T+500ms
- AND the edit contains the concatenated text from all accumulated deltas

### R3: 4096-char limit

#### Scenario: Answer exceeds Telegram limit

- GIVEN accumulated final answer text is 5000 characters
- WHEN the bot attempts to send the message
- THEN the content is truncated to 4096 characters
- AND a `… (truncated)` suffix is appended
