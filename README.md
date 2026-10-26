# pi-telegram

![pi-telegram screenshot](screenshot.png)

> Full pi build session: [View the session transcript](https://pi.dev/session/#14acfe07b7844c8abec55ed9fbddc17f), which captures the full pi session in which `pi-telegram` was built.

Telegram DM bridge for pi.

## Install

From git:

```bash
pi install git:github.com/johnbitcn/pi-telegram
```

Or for a single run:

```bash
pi -e git:github.com/johnbitcn/pi-telegram
```

For local development, install this checkout from its directory:

```bash
npm ci --legacy-peer-deps
pi install .
```

If the upstream package is already installed, remove it first with `pi remove git:github.com/badlogic/pi-telegram`. Do not load both copies: they would register the same commands and compete for bot updates. Run `/reload` after switching packages or changing the source.

## Configure

### Telegram

1. Open [@BotFather](https://t.me/BotFather)
2. Run `/newbot`
3. Pick a name and username
4. Copy the bot token

### pi

Start pi, then run:

```bash
/telegram-setup
```

Paste the bot token when prompted.

The extension stores config in:

```text
~/.pi/agent/telegram.json
```

## Connect a pi session

The Telegram bridge is session-local. Connect it only in the pi session that should own the bot:

```bash
/telegram-connect
```

To stop polling in the current session:

```bash
/telegram-disconnect
```

Check status:

```bash
/telegram-status
```

## Pair your Telegram account

After token setup and `/telegram-connect`:

1. Open the DM with your bot in Telegram
2. Send `/start`

The first DM user becomes the allowed Telegram user for the bridge. The extension only accepts messages from that user.

## Usage

Chat with your bot in Telegram DMs.

### Sync PC conversations to Telegram

By default, only conversations started in Telegram are sent back to Telegram. To also mirror conversations started in the pi terminal, connect and pair the bot, then run in the terminal:

```text
/telegram-sync
```

Run it again to turn sync off. You can also set the state explicitly:

```text
/telegram-sync on
/telegram-sync off
```

When enabled:
- New terminal user messages appear in the bot DM with a bold `👤 你 · PC` heading and a blank line before the message body. The body stays literal, so source code and Markdown in your prompt are not reformatted.
- Assistant text, including intermediate replies before tool calls, uses the same streaming previews as Telegram-originated replies.
- Telegram messages still appear in the terminal with `[telegram]`; they are not echoed back to Telegram.
- Long messages are split to fit Telegram's message limit.
- `/telegram-status` shows `conversation sync: on` or `off`; the terminal status label shows `telegram sync` while enabled.

Sync is off by default and is not saved to config. Enable it before starting the next PC conversation. Turning it off stops the remaining output of an active PC conversation from being sent; normal Telegram replies still work. `/telegram-disconnect` also turns sync off. Restarting pi or reloading the extension resets it to off.

Only new conversation text is mirrored. Existing session history, slash-command output, thinking blocks and raw tool output are not copied. PC image inputs get a text placeholder, not an image upload. Files are sent only when queued with `telegram_attach` during an active Telegram or synced PC turn.

**Privacy:** while sync is on, terminal prompts and assistant text can include source code, local paths and other sensitive information. They are sent to your paired Telegram account through the bot. Turn sync off before discussing secrets. Failed sends are reported in the terminal; there is no offline backlog or automatic history replay.

### Send text

Send any message in the bot DM. It is forwarded into pi with a `[telegram]` prefix.

### Send images and files

Send images, albums, or files in the DM.

The extension:
- downloads them to `~/.pi/agent/tmp/telegram`
- includes local file paths in the prompt
- forwards inbound images as image inputs to pi

### Ask for files back

If you ask pi for a file or generated artifact, pi should call the `telegram_attach` tool. The extension then sends those files with the next Telegram reply.

Examples:
- `summarize this image`
- `read this README and summarize it`
- `write me a markdown file with the plan and send it back`
- `generate a shell script and attach it`

### Stop a run

In Telegram, send:

```text
stop
```

or:

```text
/stop
```

That aborts the active pi turn.

### Queue follow-ups

If you send more Telegram messages while pi is busy, they are queued and processed in order.

## Streaming

The extension streams assistant text previews back to Telegram while pi is generating.

It tries Telegram draft streaming first with `sendMessageDraft`. If that is not supported for your bot, it falls back to `sendMessage` plus `editMessageText`.

## Message formatting

Assistant Markdown is parsed with `marked` and converted to Telegram **MarkdownV2**. It is not passed through unchanged: CommonMark `**bold**` becomes Telegram `*bold*`, for example.

Supported layout:
- Headings become bold text.
- Bold, italic, strikethrough, inline code, fenced code blocks and links are converted to Telegram formatting.
- Bullet, numbered and task lists keep readable markers.
- Blockquotes use Telegram quote formatting. Nested quotes are flattened; code and links inside quotes keep their visible text without nested code/link formatting, following Telegram's entity-nesting restrictions.
- GFM tables become pipe-separated fixed-width text, not native tables.
- HTML is shown literally. Telegram-only extensions such as custom emoji and expandable quotes are not interpreted.

PC user messages keep their exact body text and receive only the bold heading. Status and error messages remain literal. Reserved MarkdownV2 characters are escaped for their context, including code and link destinations.

Drafts, message previews, edits and final replies use the same formatter. Incomplete streamed markup is escaped or closed until more content arrives. Long messages are split by rendered text length, with formatting closed and reopened in each message. Splitting does not cut UTF-16 surrogate pairs.

If Telegram explicitly returns a `400` entity-parsing error, that request is retried once as readable plain text. Network, rate-limit and permission failures do not trigger this retry. There is no offline delivery queue.

Official references consulted for this implementation:
- [Formatting options and MarkdownV2](https://core.telegram.org/bots/api#formatting-options)
- [sendMessage](https://core.telegram.org/bots/api#sendmessage)
- [sendMessageDraft](https://core.telegram.org/bots/api#sendmessagedraft)
- [editMessageText](https://core.telegram.org/bots/api#editmessagetext)
- [MessageEntity](https://core.telegram.org/bots/api#messageentity)

## Notes

- Only one pi session should be connected to the bot at a time
- Replies are sent as normal Telegram messages, not quote-replies
- Long replies are split below Telegram's 4096 character limit
- Outbound files are sent via `telegram_attach`

## Tests

With Node.js 22.18 or later:

```bash
npm ci --legacy-peer-deps
npm test
```

Tests use the built-in Node.js test runner, an isolated temporary config and a mocked Telegram API. They do not contact Telegram or change your real bot settings. The tool-schema peer dependency is stubbed in these tests; live Telegram integration is not covered.

## License

MIT
