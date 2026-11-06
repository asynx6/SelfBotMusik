# SelfBotMusic

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
│   ├── binaries.js           ffmpeg / yt-dlp path resolution
│   ├── discord.js            Discord client factory + safety bind
│   ├── poru-manager.js       Poru lifecycle, node connect/disconnect
│   ├── player.js             Search / queue / play / pause / loop
│   └── webserver.js          Express + WS + all /api routes
├── bin/                      Bundled ffmpeg + yt-dlp (fetched, git-ignored)
├── scripts/
│   └── fetch-binaries.js     Downloads the binaries for this platform
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
npm install                 # also fetches ffmpeg + yt-dlp into ./bin
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

## Bundled binaries (ffmpeg + yt-dlp)

The app shells out to two external programs: **ffmpeg** (decode local audio
into PCM for the Discord voice connection) and **yt-dlp** (download tracks into
the library). Both live in `./bin` so no absolute path has to be configured.

```bash
npm run setup:bin     # download what is missing (~115 MB total)
npm run update:bin    # force re-download — use this to update yt-dlp
```

`npm install` runs the fetch automatically. Set `SKIP_BINARY_FETCH=1` to skip
it. Downloads are single-file (no archive extraction) and platform-aware:
`ffmpeg-static` release assets for ffmpeg, standalone builds for yt-dlp.

Resolution order at runtime (`modules/binaries.js`):

1. `FFMPEG_PATH` / `YTDLP_PATH` environment variable
2. `./bin/<name>` — bundled
3. `settings.ffmpeg_path` / `settings.ytdlp_path` in SQLite
4. bare `ffmpeg` / `yt-dlp`, looked up on `PATH`

Bundled binaries deliberately outrank the settings table, so a database copied
from another machine cannot leave the container pointing at a stale path.
The boot log prints which binary was chosen and whether it is bundled.

## Deploying on Pterodactyl

The standard `nodejs` yolk ships no ffmpeg and no yt-dlp, and `/home/container`
is the only persistent writable directory. This project is built for that:

1. Upload the repository (or `git clone`) into `/home/container`.
2. Run `npm install` — the `postinstall` hook drops the Linux binaries into
   `bin/` and marks them executable.
3. Start the server. The boot log should show `(bundled)` for both binaries.

Notes:

- If `npm install` times out during the binary download, run
  `npm run setup:bin` afterwards, or pre-fetch during the egg install script.
- Use a **Debian-based** image (`ghcr.io/pterodactyl/yolks:nodejs_*`). The
  prebuilt ffmpeg requires glibc; Alpine/musl is not supported for ffmpeg
  (yt-dlp has a musl build, ffmpeg does not).
- The two binaries occupy roughly **115 MB** of the server's disk quota
  (ffmpeg ≈ 76 MB, yt-dlp ≈ 39 MB). Raise the quota accordingly.
- yt-dlp breaks whenever YouTube changes; run `npm run update:bin` periodically.
- `data/` holds the SQLite database and the audio library — back that up, not
  `bin/`.

### Running 24/7 on a small container (memory)

A Node process does **not** size its heap from the container limit: it reads the
host's physical memory. On a 500 MB panel the default heap ceiling is still
~2 GB, so V8 sees no pressure and defers garbage collection until the kernel
OOM-kills the process. That is why the bot starts small and "swells" later.

`npm start` therefore caps the heap explicitly:

```
npm start            # node --max-old-space-size=160 index.js
npm run start:plain  # no cap — only for hosts with plenty of RAM
```

Measured ceiling for each value (`v8.getHeapStatistics().heap_size_limit`):

| `--max-old-space-size` | heap ceiling | leaves for native + ffmpeg/yt-dlp on 500 MB |
|---|---|---|
| 128 | 320 MB | 180 MB |
| **160 (default)** | **352 MB** | **148 MB** |
| 192 | 384 MB | 116 MB |
| 256 | 448 MB | 52 MB |

Raise the number if you move to a 1 GB panel; the app itself idles well below
100 MB of heap, so the cap is a safety net, not a working limit.

A watchdog prints one line every 10 minutes (`MEMORY_LOG_MS=0` disables it):

```
📊 mem rss=96MB heap=58/352MB ext=12MB ab=1MB ws=1 queue=12
```

How to read it:

- `heap` climbing steadily → retained JS objects (queue growth, listener leak).
- `ext` or `ab` climbing → buffered sockets or native allocations. `heap` looks
  fine in this case, which is why heap-only profiling misses it.
- `ws` never returning to 0 after you close the dashboard → dead sockets.

What is already bounded for you: WebSocket clients are pinged every 30 s and
terminated when they stop answering, any client with more than 1 MB queued is
dropped instead of buffered, dashboard pushes are coalesced into one frame per
150 ms, played queue entries are compacted away every 64 tracks, and the Discord
caches are capped (100 messages/channel, 500 users, 100 presences) with a
30-minute message sweep.

**What is *not* in RAM.** Audio is never held in memory as a file. `LocalEngine`
pipes ffmpeg's stdout into the voice encoder in ~20 ms frames, Lavalink streams
server-side, and uploads/downloads are hashed as they stream to disk. A queue
entry is metadata only — measured at ~240 bytes per track. So "the queue is
eating RAM" is never about the audio; it is about how many entries the array
holds and how often it is re-serialized.

**RSS not going down is normal.** V8 frees heap objects but does not return the
pages to the OS immediately. Measured on this project:

```
baseline              rss=  35MB  heap=   5MB
after 90MB of objects rss= 177MB  heap= 100MB
freed + forced GC     rss= 172MB  heap=   5MB   <- heap reclaimed, RSS not
```

A healthy process shows `heap` oscillating and `rss` plateauing. Only a
monotonically rising `rss` with a flat `heap` is a real problem — that points at
native buffers (sockets, sqlite, ffmpeg), not at JavaScript.

### Disk budget for a small panel (900 MB)

Measured footprint of a Linux deployment:

| Component | Size | Needed at runtime? |
|---|---|---|
| `node_modules/` (runtime deps only) | 64 MB | yes |
| `bin/` ffmpeg + yt-dlp | ~115 MB | yes |
| `public/` (pre-built dashboard) | 0.2 MB | yes |
| `.git/` | ~2 MB | optional |
| **baseline** | **~185 MB** | |
| `web/` (Vite/React build tooling) | 74 MB | **no** — exclude from upload |

That leaves roughly 700 MB for the library, the database and headroom. Suggested
values for a 900 MB panel:

```sql
UPDATE settings SET value = '0.35' WHERE key = 'library_quota_gb';  -- ≈ 375 MB
UPDATE settings SET value = '50'   WHERE key = 'max_upload_mb';     -- per file
UPDATE settings SET value = '1'    WHERE key = 'download_concurrency';
```

`library_quota_gb` accepts decimals — it is parsed with `parseFloat`, so `0.35`
means 375 MB. Budget: 185 baseline + 375 library + 128 reserve ≈ 690 MB, leaving
~210 MB for SQLite, WAL, temp downloads and panel overhead.

Do **not** upload `web/node_modules` — the dashboard is already built into
`public/assets`. Uploading it costs 74 MB and changes nothing at runtime.

**Free-space guard.** The library quota only bounds the tracks; it says nothing
about the volume itself. Both the download manager and the upload handler now
check real free space with `statfs` and refuse to write when less than
`DISK_RESERVE_MB` (default 128) would remain:

```
download failed: Disk hampir penuh: sisa 96 MB, reserve 128 MB
```

Set `DISK_RESERVE_MB=0` to disable. The watchdog line also reports `disk_free`.

### Developing on Windows, deploying to Linux

`npm install` on Windows writes `bin/ffmpeg.exe` and `bin/yt-dlp.exe`. Those
are useless inside a Linux container — and harmless: the resolver looks for
`bin/ffmpeg` (no suffix) on Linux, so a stray `.exe` is never executed by
mistake.

Two safe ways to deploy:

- **via git (recommended)** — `bin/*` is git-ignored, so the container clones
  an empty `bin/` and its own `npm install` fetches the Linux builds. Platform
  binaries never cross over.
- **by uploading the folder** — run `npm run setup:bin` after the upload. It
  deletes the foreign `.exe` files automatically (they would otherwise waste
  ~100 MB of the panel quota) and fetches the Linux builds. Pass `--no-prune`
  to keep them.

The asset mapping is covered by `test/fetch-binaries.test.js`, including the
`linux/x64` and `linux/x64 + musl` cases, so the Pterodactyl path is verified
without needing a Linux machine.

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
- Session cookie is `HttpOnly`, `SameSite=Strict`, 2-day JWT TTL.
- 10 failed logins per minute per IP — 11th gets `HTTP 429` with a `Retry-After`
  header. The budget clears as failures age past 60 seconds; there is no separate
  15-minute lockout.
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
