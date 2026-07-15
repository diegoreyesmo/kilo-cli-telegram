# user-interaction Specification

Inline keyboard rendering for permission requests and AI-posed questions, with callback routing.

## Requirements

| # | Requirement | Strength |
|---|-------------|----------|
| R1 | System MUST render `permission.asked` events with Approve/Deny inline buttons | MUST |
| R2 | System MUST render `question.asked` events with one button per option | MUST |
| R3 | System SHALL resolve permission callbacks via `kiloClient.permission.resolve()` | SHALL |
| R4 | System SHALL answer question callbacks via `kiloClient.question.answer()` | SHALL |

### R1: Permission rendering

#### Scenario: Tool wants to run a shell command

- GIVEN a `permission.asked` event with `tool: "bash"`, `input: { command: "rm -rf /" }`, `permissionId: "p1"`
- WHEN the bot receives the event
- THEN it sends a message showing the tool name and input
- AND renders two inline buttons: `✅ Approve` (`approve:p1`) and `❌ Deny` (`deny:p1`)
- AND session `status` transitions to `waiting_interaction`

#### Scenario: User approves permission

- GIVEN an active permission message with `approve:p1` callback
- WHEN user taps the Approve button
- THEN `kiloClient.permission.resolve({ permissionId: "p1", approved: true })` is called
- AND the permission message is deleted
- AND session `status` returns to `processing`

#### Scenario: User denies permission

- GIVEN an active permission message with `deny:p1` callback
- WHEN user taps the Deny button
- THEN `kiloClient.permission.resolve({ permissionId: "p1", approved: false })` is called
- AND the permission message is deleted
- AND session `status` returns to `processing`

### R2: Question rendering

#### Scenario: AI asks which file to edit

- GIVEN a `question.asked` event with `question: "Which file?", options: ["a.ts", "b.ts"], questionId: "q1"`
- WHEN the bot receives the event
- THEN it sends a message with the question text and one button per option
- AND each button callback data is `answer:q1:{option}`

#### Scenario: User selects an option

- GIVEN a question message with options
- WHEN user taps an option button
- THEN `kiloClient.question.answer({ questionId: "q1", answer: "a.ts" })` is called
- AND the question message is deleted
