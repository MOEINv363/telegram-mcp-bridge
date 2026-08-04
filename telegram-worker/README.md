# Telegram Bridge — Cloudflare Worker (optional layer) ☁️

Always-on Telegram bot worker with **smart routing**:

1. User sends a message to the bot
2. Worker checks if your **local Claude bridge** is online (via tunnel → `BRIDGE_URL`)
3. If online → the local bridge answers with **your Claude** (smart mode)
4. If offline → Worker answers with **Google Gemini** (always available)

## Why two layers?

- **Local bridge (your PC):** full Claude Code, MCP, image vision, feedback reporting — highest quality, but only works while your computer is on.
- **Worker (Cloudflare):** always online, replies even when your PC sleeps — with Gemini as an always-available fallback model.

## Features

- **Instant reaction** — reacts to every incoming message 👍❤️🔥
- **Reply with feedback buttons** — 👍 / 👎 / 🚩 Report on every reply
- **Report forwarding** — reports are sent to the admin (`ADMIN_ID`)
- **Photo support** — caption-based replies (vision via the local bridge when online)

## Setup

```bash
npm install
npx wrangler login
```

Set secrets:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN   # your bot token
npx wrangler secret put GEMINI_API_KEY        # Google AI Studio key
npx wrangler secret put BRIDGE_URL            # e.g. https://your-name.serveousercontent.com (your local bridge tunnel)
npx wrangler secret put GEMINI_MODEL          # optional: gemini-flash-latest
npx wrangler secret put ADMIN_ID              # your Telegram user ID (receives reports)
```

Deploy:

```bash
npx wrangler deploy
```

Then set Telegram webhook to your worker URL:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<worker-name>.<subdomain>.workers.dev"
```

## Local bridge endpoints

The worker calls your bridge at `/api/health` and `/api/ask`:

- `GET /api/health` — returns `{"ok":true,"online":true}` when online
- `POST /api/ask` — body `{"chat_id":0,"text":"..."}` → returns `{"ok":true,"reply":"..."}`

To use the worker as the message handler, run the local bridge with:

```bash
POLLING=false WORKER_MODE=true node server.js
```

## Note

- No secrets are committed — everything is in Cloudflare secrets/vars.
- The worker is intentionally simple (no KV needed for stateless fallback replies).
