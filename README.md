# Telegram MCP Bridge 🤖

A self-hosted bridge that connects a **Telegram bot** to **Claude Code** over the Model Context Protocol (MCP), with an **instant auto-reply** layer so the bot answers users immediately — even when the Claude app is closed.

## Features ✨

- **Instant auto-replies** — any message to the bot gets an AI reply in ~2 seconds (OpenAI-compatible LLM)
- **Claude integration** — messages containing a keyword (default: `claude`) are routed to Claude Code for full-powered answers
- **Emoji reactions** — automatically reacts to every incoming message 👍❤️🔥
- **Per-chat context** — each user only sees their own conversation history
- **History persistence** — conversations survive restarts (saved to `.history.json`)
- **Allowlist support** — optional: restrict usage to specific Telegram user IDs
- **SSE MCP server** — Claude connects over `http://127.0.0.1:8765/sse`
- **Startup launcher** — runs at login, always available

## Architecture 🏗️

```
Telegram bot ←→ bridge (node) ←→ LLM (auto-reply, instant)
                      │
                      └── MCP over SSE ←→ Claude Code (smart mode)
```

## Setup 🚀

### Prerequisites
- Node.js 18+
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- An OpenAI-compatible LLM endpoint + API key

### Install

```bash
npm install
cp config.env.example config.env
# edit config.env with your values
```

### Run (manual)

```bash
node server.js
```

### Run (auto-start at login, Windows)

Create a `.bat` in the Startup folder (`shell:startup`) that sets the env vars from `config.env` and runs `node server.js`.

### Connect Claude Code

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "telegram": {
      "type": "sse",
      "url": "http://127.0.0.1:8765/sse"
    }
  }
}
```

## Configuration ⚙️

See `config.env.example` for all options: bot token, allowlist, SSE port, auto-reply model, fallback model, Claude keyword.

## Security 🔒

- **Never commit `config.env`** — it contains your bot token and API keys
- Allowlist (`ALLOWED_USER_IDS`) restricts who can use the bot — recommended for private bots
- The auto-reply uses your LLM API key — a public bot means anyone can consume your quota

## License 📄

MIT
