# SelfBotMusik

Self-hosted Discord music bot (user-token / selfbot) that streams audio through
your own Lavalink v4 server and exposes a sleek web dashboard for control.

-  🎵 Search & play YouTube / playlists / URLs through Lavalink
-  ⏯️ Play / pause / stop / skip / volume / loop (3 modes)
-  📜 Queue with per-track remove + clear-all
-  🔌 Manual connect / disconnect (bot never auto-joins VC)
-  🛡️ Safety: auto rejoin VC on drops, channel deletion, guild logout
-  🔐 Password-protected dashboard (JWT cookie, rate-limited login)
-  🗄️ SQLite-backed config, user, JWT secret, audit log

## Stack

- Node.js ≥ 18
- discord.js-selfbot-v13 (user token, not a bot token)
- Poru 5 (Lavalink v4 / NodeLink v5 client)
- better-sqlite3 (file-based persistent DB)
- bcryptjs + jsonwebtoken + cookie-parser

## Project layout

```
.
├── index.js                  Slim orchestrator (login, lifecycle, glue)
├── modules/
│   ├── database.js           SQLite + settings, users, attempts, audit
│   ├── config.js             Load/save runtime config from SQLite
│   ├── auth.js               JWT issued/verified · bcrypt · rate limit
│   ├── state.js              Live UI mirror + event emitter
│   ├── runtime.js            Runtime config patcher
│   ├── discord.js            Discord client factory + safety bind
│   ├── poru-manager.js       Poru lifecycle, node connect/disconnect
│   ├── player.js             Search / queue / play / pause / loop
│   └── webserver.js          Express + WS + all /api routes
├── public/                   Front-end (HTML/CSS/JS)
├── data/
│   └── app.sqlite            Auto-created on first boot
├── .env                      Only `TOKEN_USER` + `WEB_PORT`
├── .gitignore
├── README.md
└── package.json
```

## Setup

```bash
git clone https://github.com/asynx6/SelfBotMusik.git
cd SelfBotMusik
npm install
cp .env.example .env        # add your Discord user token
node index.js
```

`.env` is the **only** place where boot-time secrets live. The web dashboard
port defaults to 3434 — change `WEB_PORT=` if needed.

```
TOKEN_USER=YOUR_DISCORD_USER_TOKEN
WEB_PORT=3434
```

> ⚠️  Selfbots violate Discord's ToS. Use at your own risk on a personal
> account only. Don't run unattended for long periods.

## First boot

1. Visit `http://localhost:3434`. You'll be redirected to `/login`.
2. Default password: **`changeme`** (the UI reminds you to change it).
3. Open **Settings** → fill in:
   - Guild (Server) ID
   - Voice Channel ID
   - Lavalink host / port / password (and TLS on/off)
4. Click **Save &amp; reconnect**.
5. Click **Connect** → the bot connects to Lavalink then joins your VC.
6. Start adding tracks from the Search bar.

## Security highlights

- Single `admin` user. Default password is auto-changed by the UI prompt right
  after the first login (use **Change password** in Settings).
- Passwords hashed with bcrypt (cost 10).
- Session cookie is `HttpOnly`, `SameSite=Strict`, 30-day JWT TTL.
- 10 failed logins per 15 min per IP — 11th gets `HTTP 429`.
- JWT secret is auto-generated on first boot and persisted in the SQLite
  database (regenerating the secret invalidates all sessions — users must
  sign in again).
- Configurable `WEB_PORT` so you can host multiple instances or run behind a
  reverse proxy with its own rate fail2ban.

## Hosting notes

- Set `secure: true` on the session cookie if you terminate HTTPS at a
  reverse proxy (edit `modules/auth.js`).
- Bind to `127.0.0.1` and front with Nginx + basic-auth + fail2ban when
  hosting publicly.
- All persistent state lives in `data/app.sqlite`. Back up that file only.

## License

MIT — [License](LICENSE)
