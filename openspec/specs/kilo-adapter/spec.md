# kilo-adapter Specification

Adapter layer for the @kilocode/sdk, managing server connection, SSE event subscription, and prompt submission.

## Requirements

| # | Requirement | Strength |
|---|-------------|----------|
| R1 | Adapter MUST connect to a local Kilo Code server at `KILO_SERVER_URL` (default `http://127.0.0.1:4096`) | MUST |
| R2 | Adapter SHALL provide a re-exported or wrapped `createKiloClient()` singleton | SHALL |
| R3 | Adapter SHALL support SSE event subscription filtered by `sessionId` | SHALL |
| R4 | Adapter SHOULD return a cleanup function for each SSE subscription | SHOULD |

### R1: Server connection

#### Scenario: Connect to running server

- GIVEN Kilo Code server is running on `KILO_SERVER_URL`
- WHEN `getKiloClient()` is called
- THEN it returns a connected client instance
- AND returns the existing instance on subsequent calls (singleton)

#### Scenario: Server unavailable

- GIVEN Kilo Code server is not running
- WHEN `getKiloClient()` is called
- THEN an error is thrown with descriptive message
- AND the error is logged via pino

### R2: SSE event subscription

#### Scenario: Receive session events

- GIVEN an active SSE connection to the server
- AND a `sessionId` filter is applied
- WHEN a `session.next.text.delta` event arrives for that `sessionId`
- THEN the registered `onEvent` callback is invoked with the parsed event

#### Scenario: Filter out other sessions

- GIVEN an active SSE subscription filtered by `sessionId: "abc"`
- WHEN an event arrives with `sessionId: "xyz"`
- THEN the `onEvent` callback is NOT invoked

### R3: Prompt submission

#### Scenario: Send prompt to session

- GIVEN a connected client and active session
- WHEN `client.session.prompt({ sessionId, text })` is called
- THEN the prompt is submitted to the Kilo Code server
- AND SSE events begin streaming for that session
