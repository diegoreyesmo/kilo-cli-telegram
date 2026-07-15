# bot-entrypoint Specification

The Telegram bot entry point using Telegraf, wiring commands and callback actions to downstream handlers.

## Requirements

| # | Requirement | Strength |
|---|-------------|----------|
| R1 | Bot MUST start and connect to Telegram using the token from `TELEGRAM_BOT_TOKEN` env var | MUST |
| R2 | Bot SHALL register `/start` command that creates a session and replies with a welcome message | SHALL |
| R3 | Bot SHALL register `/new` to reset session and `/stop` to cancel current prompt | SHALL |
| R4 | Bot SHALL route inline callback data with prefixes `approve:`, `deny:`, `answer:` to interaction handlers | SHALL |

### R1: Bot startup

The bot MUST initialize Telegraf with the Telegram token and start polling.

#### Scenario: Successful startup

- GIVEN a valid `TELEGRAM_BOT_TOKEN` environment variable
- WHEN the bot process starts
- THEN Telegraf launches in polling mode
- AND logs "Bot started" via pino

#### Scenario: Missing token

- GIVEN `TELEGRAM_BOT_TOKEN` is not set
- WHEN the bot process starts
- THEN the process exits with an error message

### R2: /start command

#### Scenario: First interaction

- GIVEN a chat with no existing session
- WHEN user sends `/start`
- THEN the bot creates a Kilo Code session via `getOrCreateSession(chatId)`
- AND replies with a welcome message including available commands

### R3: /new and /stop commands

#### Scenario: Reset with /new

- GIVEN an existing session with history
- WHEN user sends `/new`
- THEN the bot resets the session to idle state
- AND clears accumulated message history

#### Scenario: Cancel with /stop

- GIVEN an active prompt being processed
- WHEN user sends `/stop`
- THEN the bot cancels via `AbortController`
- AND sets session status to idle

### R4: Callback routing

#### Scenario: Permission callback

- GIVEN an inline keyboard message with `approve:perm123` callback data
- WHEN user taps the button
- THEN the bot routes to `interactionHandler.resolvePermission(permissionId, approved: true)`
- AND removes the inline keyboard from the message

#### Scenario: Unknown callback prefix

- GIVEN callback data with an unrecognized prefix
- WHEN user taps the button
- THEN the bot answers the callback query with an error
- AND logs a warning
