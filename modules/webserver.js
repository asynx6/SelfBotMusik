"use strict";

const path = require("path");
const express = require("express");
const http = require("http");
const cookieParser = require("cookie-parser");
const { WebSocketServer } = require("ws");

const auth = require("./auth");
const cfg = require("./config");
const stateMod = require("./state");
const db = require("./database");
const library = require("./library");
const downloads = require("./downloads");
const uploads = require("./uploads");
const playlists = require("./playlists");
const likes = require("./likes");
const history = require("./history");
const recommendations = require("./recommendations");
const { createBroadcaster } = require("./broadcaster");

// Serialize a DB track row for API responses, adding downloaded/downloading flags.
function serializeApiTrack(track) {
    if (!track) return null;
    const info = track.info || {};
    return {
        id: track.id,
        title: track.title || info.title || "Unknown",
        author: track.artist || track.author || info.author || "Unknown",
        duration: track.duration_ms ?? track.duration ?? info.length ?? 0,
        uri: track.uri || info.uri || "",
        thumbnail: track.cover_url
            || info.artworkUrl
            || (track.identifier ? `https://i.ytimg.com/vi/${track.identifier}/hqdefault.jpg` : "")
            || "",
        downloaded: !!track.file_path,
        downloading: false, // set by caller when downloads service available
    };
}

// Build the full Express app + HTTP server + WebSocket bridge.
// ctx exposes: enqueue/skip/stop/pause/setVolume/cycleLoop/setLoop/removeAt/clearQueue,
//              joinVC, leaveVC, ensurePoru, Runtime, getPlayer, stopAll, removePoruNode
function buildServer(ctx) {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());

    // Services: ctx can inject mocks (tests) or pre-wired instances (task 9);
    // fall back to the singleton modules for standalone use.
    const lib = ctx.library || library;
    const dl = ctx.downloads || downloads;
    const pc = ctx.playerController || null;
    const searchTracksFn = ctx.searchTracks || null;
    const pl = ctx.playlists || playlists;
    const lk = ctx.likes || likes;
    const hist = ctx.history || history;
    const rec = ctx.recommendations || recommendations;

    // Dashboard state broadcaster: coalesces bursts, drops stalled peers, and
    // keeps a ping/pong heartbeat so dead sockets cannot accumulate.
    const broadcaster = createBroadcaster({ getSnapshot: () => stateMod.snapshot() });
    const onChange = () => broadcaster.request("change");

    // --- Auth gate: all /api/* except /api/auth/* and /api/stream/* need a valid JWT cookie. ---
    app.use("/api", (req, res, next) => {
        if (req.path.startsWith("/auth/") || req.path === "/auth") return next();
        // Allow unauthenticated internal audio streaming for local Lavalink
        if (req.path.startsWith("/stream/")) return next();
        if (auth.verifyToken(req)) return next();
        res.status(401).json({ error: "Unauthorized", unAuthed: true });
    });

    // --- Custom HTML gate: protect the dashboard shell BEFORE static runs. ---
    // "/index.html" is listed explicitly because express.static would otherwise
    // serve the shell straight off disk, skipping the login redirect entirely.
    const publicDir = path.join(__dirname, "..", "public");
    const indexFile = path.join(publicDir, "index.html");

    app.get(["/", "/index.html"], (req, res) => {
        if (!auth.verifyToken(req)) return res.redirect("/login");
        // Served directly: express.static below runs with `index: false`, so
        // the shell can only ever come out of this authenticated branch.
        return res.sendFile(indexFile);
    });

    // --- Login + static files serving. ---
    app.get("/login", (req, res) => {
        if (auth.verifyToken(req)) return res.redirect("/");
        res.set("Content-Type", "text/html; charset=utf-8");
        res.send(renderLoginPage());
    });
    // `index: false` keeps the shell behind the gate above; assets stay public.
    app.use(express.static(publicDir, { index: false }));

    // JWT-protected login page (served from template, no static file needed)
    function renderLoginPage() {
        return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SelfBotMusic · Login</title>
    <meta name="description" content="Sign in to the SelfBotMusic dashboard." />
    <meta name="theme-color" content="#0e0f12" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet" />
    <style>
        /* Same design tokens as web/src/styles/global.css (grey + orange). */
        :root {
            --bg: #0f0f0f;
            --surface: #181818;
            --surface-2: #202020;
            --border: #333333;
            --border-hover: #404040;
            --text: #ffffff;
            --text-dim: #b3b3b3;
            --text-muted: #737373;
            --accent: #ff6b00;
            --accent-hover: #ff8533;
            --accent-soft: rgba(255, 107, 0, 0.12);
            --error: #ff3b30;
            --radius-sm: 6px;
            --radius-md: 10px;
            --radius-lg: 16px;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            margin: 0; min-height: 100vh;
            display: grid; place-items: center;
            padding: 24px;
            background:
                radial-gradient(circle at 50% 0%, rgba(255,107,0,0.07) 0, transparent 55%),
                var(--bg);
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
            color: var(--text);
            -webkit-font-smoothing: antialiased;
        }
        .login-card {
            width: min(400px, 100%);
            background: var(--surface);
            border: 1px solid var(--border);
            padding: 32px 28px 28px;
            border-radius: var(--radius-lg);
            box-shadow: 0 24px 64px -24px rgba(0,0,0,0.75);
        }
        .login-logo {
            width: 52px; height: 52px;
            border-radius: var(--radius-md);
            background: var(--accent);
            color: #ffffff;
            font-size: 26px; font-weight: 800;
            display: grid; place-items: center;
            margin-bottom: 18px;
            box-shadow: 0 8px 24px -8px rgba(255,107,0,0.65);
        }
        .login-title { font-size: 21px; font-weight: 700; letter-spacing: -0.4px; }
        .login-sub { color: var(--text-muted); font-size: 13px; margin-top: 5px; }
        .login-form { margin-top: 26px; }
        .login-field { margin-bottom: 16px; }
        .login-field label {
            display: block; font-size: 11px; color: var(--text-muted);
            text-transform: uppercase; letter-spacing: 0.06em;
            font-weight: 600; margin-bottom: 7px;
        }
        .login-field input {
            width: 100%; height: 44px; padding: 0 13px;
            background: var(--surface-2); border: 1px solid var(--border);
            color: var(--text); border-radius: var(--radius-sm);
            font-size: 14px; font-family: inherit; outline: none;
            transition: border-color 150ms ease, box-shadow 150ms ease;
        }
        .login-field input::placeholder { color: var(--text-muted); }
        .login-field input:focus {
            border-color: var(--accent);
            box-shadow: 0 0 0 3px var(--accent-soft);
        }
        .login-btn {
            width: 100%; height: 44px;
            background: var(--accent); color: #ffffff; border: none;
            border-radius: var(--radius-sm); font-size: 14px; font-weight: 600;
            cursor: pointer; transition: background 150ms ease;
            margin-top: 6px;
        }
        .login-btn:hover:not(:disabled) { background: var(--accent-hover); }
        .login-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .login-error {
            display: none;
            margin-top: 14px; padding: 10px 12px;
            background: rgba(255, 59, 48, 0.1);
            border: 1px solid rgba(255, 59, 48, 0.35);
            border-radius: var(--radius-sm);
            color: #ff8a80; font-size: 12.5px; line-height: 1.5;
        }
        .login-error.visible { display: block; }
    </style>
</head>
<body>
    <div class="login-card">
        <div class="login-logo">S</div>
        <div class="login-title">SelfBotMusic</div>
        <p class="login-sub">Sign in to your dashboard</p>
        <form class="login-form" id="loginForm">
            <div class="login-field">
                <label for="password">Password</label>
                <input id="password" type="password" name="password" autocomplete="current-password" required placeholder="Enter password" />
            </div>
            <button type="submit" class="login-btn">Sign In</button>
            <div class="login-error" id="loginError" role="alert"></div>
        </form>
    </div>
    <script>
        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const form = e.target;
            const btn = form.querySelector('button');
            const errorBox = document.getElementById('loginError');
            const pwd = form.password.value;

            errorBox.classList.remove('visible');
            btn.disabled = true;
            btn.textContent = 'Signing in…';
            try {
                const res = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: pwd })
                });
                const data = await res.json().catch(() => ({}));
                if (res.ok && data.ok) {
                    window.location.href = '/';
                    return;
                }
                // Inline message instead of a native alert().
                errorBox.textContent = data.error || 'Login failed';
                errorBox.classList.add('visible');
            } catch (err) {
                errorBox.textContent = 'Network error: ' + err.message;
                errorBox.classList.add('visible');
            }
            btn.disabled = false;
            btn.textContent = 'Sign In';
        });
    </script>
</body>
</html>`;
    }

    // === Auth endpoints ===
    app.get("/api/auth/status", (req, res) => {
        const rt = ctx.RuntimeSnapshot();
        const needsSetup = !rt.lavaHost || !rt.lavaPass
            || !rt.guildId || !rt.channelId;
        const verified = auth.verifyToken(req);
        if (req.query.whoami === "1") {
            return res.json({ authed: verified, role: verified ? "admin" : null });
        }
        res.json({ authed: verified, needsSetup });
    });

    app.post("/api/auth/login", (req, res) => {
        const ip = req.ip || req.headers["x-forwarded-for"] || "?";
        if (!auth.attemptsAllowed(ip)) {
            // 10 failures per rolling minute; no separate lockout. Tell the client
            // exactly when the oldest failure drops out of the window.
            const retryAfter = auth.loginRetryAfterSeconds(ip);
            res.set("Retry-After", String(retryAfter));
            return res.status(429).json({
                error: `Too many failed attempts (${auth.LOGIN_MAX_TRIES}/minute). Try again in ${retryAfter}s.`,
                retryAfter,
            });
        }
        const pw = req.body?.password;
        if (!pw) {
            auth.recordLoginAttempt(ip, false);
            return res.status(400).json({ error: "Password required" });
        }
        if (!auth.verifyPassword("admin", pw)) {
            auth.recordLoginAttempt(ip, false);
            return res.status(401).json({ error: "Wrong password" });
        }
        auth.recordLoginAttempt(ip, true);
        auth.pruneAttempts();
        db.db.prepare("UPDATE users SET last_login = ? WHERE username = ?").run(Date.now(), "admin");
        auth.issueToken(res);
        db.audit("login_ok", String(ip));
        console.log(`🔐 Login from ${ip}`);
        res.json({ ok: true, role: "admin" });
    });

    app.post("/api/auth/logout", (req, res) => {
        res.clearCookie(auth.SESSION_COOKIE, { path: "/" });
        db.audit("logout", null);
        res.json({ ok: true });
    });

    app.post("/api/auth/change-password", (req, res) => {
        if (!auth.verifyToken(req)) return res.status(401).json({ error: "Unauthorized" });
        const { current, next: nextPw } = req.body || {};
        if (!current || !nextPw) return res.status(400).json({ error: "Current and new password are required" });
        if (String(nextPw).length < 4) return res.status(400).json({ error: "New password must be ≥ 4 characters" });
        if (String(nextPw).length > 256) return res.status(400).json({ error: "New password too long" });
        if (!auth.verifyPassword("admin", current)) return res.status(401).json({ error: "Current password is wrong" });
        auth.setPassword("admin", nextPw);
        db.audit("password_changed", "length=" + String(nextPw).length);
        auth.issueToken(res);
        res.json({ ok: true });
    });

    // === Public API ===
    app.get("/api/state", (_req, res) => {
        if (pc && typeof pc.getSnapshot === "function") {
            ctx.syncStateFromPlayer?.();
            return res.json({ ...stateMod.snapshot(), ...pc.getSnapshot() });
        }
        ctx.syncStateFromPlayer();
        res.json(stateMod.snapshot());
    });

    app.get("/api/config", (_req, res) => {
        res.json(cfg.publicConfig(ctx.RuntimeSnapshot()));
    });

    // --- Manual connect (re-build the Poru node, wait, then joinVC) ---
    app.post("/api/connect", async (_req, res) => {
        try {
            if (!stateMod.State.botReady) return res.status(503).json({ error: "Discord bot is not ready" });
            const rt = ctx.RuntimeSnapshot();
            if (!rt.guildId || !rt.channelId) {
                return res.status(400).json({ error: "Set Guild + Voice Channel in Settings first", code: "MISSING_IDS" });
            }
            // SAFETY: confirm guild + channel + permissions BEFORE joining.
            try { await ctx.probePermissions(rt.guildId, rt.channelId); }
            catch (e) { return res.status(400).json({ error: e.message, code: e.code || "PROBE" }); }

            // Lavalink is OPTIONAL. When it is configured but unreachable, we must
            // still join voice so downloaded tracks can be played offline — a bad
            // Lavalink setting should degrade to local mode, not block Connect.
            const hasLavalinkConfig = !!(rt.lavaHost && rt.lavaPass);
            let lavalinkUp = false;
            let lavalinkError = null;
            if (hasLavalinkConfig) {
                try {
                    await ctx.ensurePoru();
                    const t0 = Date.now();
                    while (!stateMod.State.connected && Date.now() - t0 < 15000) {
                        await new Promise((r) => setTimeout(r, 200));
                    }
                    lavalinkUp = !!stateMod.State.connected;
                    if (!lavalinkUp) lavalinkError = "Lavalink tidak merespons dalam 15 detik";
                } catch (e) {
                    lavalinkError = e.message;
                }
                if (!lavalinkUp) {
                    console.warn(`⚠️  Lavalink tidak tersedia (${lavalinkError}) — melanjutkan dalam mode lokal`);
                }
            }

            // The user wants: connect VC even if there's nothing playing yet.
            // joinVC itself is non-throwing except on permission errors.
            await ctx.joinVC(rt.guildId, rt.channelId, { lavalinkUp });
            console.log(`🔌 Manual connect → guild=${rt.guildId} channel=${rt.channelId} (${lavalinkUp ? "lavalink" : "lokal"})`);
            res.json({
                ok: true,
                guildId: rt.guildId,
                channelId: rt.channelId,
                voiceConnected: true,
                mode: lavalinkUp ? "lavalink" : "local",
                ...(lavalinkError ? { warning: `Mode lokal: ${lavalinkError}` } : {}),
            });
        } catch (e) {
            console.error("api/connect:", e);
            res.status(500).json({ error: e.message, code: e.code || "JOIN" });
        }
    });

    app.post("/api/disconnect", async (req, res) => {
        try {
            const force = !!(req.body && req.body.force);
            await ctx.leaveVC(force);
            res.json({ ok: true });
        } catch (e) {
            console.error("api/disconnect:", e);
            res.status(409).json({ error: e.message });
        }
    });

    // --- Legacy dashboard endpoints, routed through PlayerController when available. ---
    app.post("/api/play", async (req, res) => {
        try {
            const query = req.body?.query || "";
            const requester = req.body?.requester || "Web";
            if (!query) return res.status(400).json({ error: "Query required" });
            if (pc) {
                if (typeof searchTracksFn !== "function") {
                    return res.status(400).json({ error: "Search service unavailable" });
                }
                const tracks = await searchTracksFn(query, requester);
                if (!tracks || !tracks.length) return res.status(400).json({ error: "No results" });
                for (const info of tracks) lib.upsertFromLavalink(info);
                const rows = tracks.map((info) => lib.findBySourceKey(`${info.sourceName}:${info.identifier}`))
                    .filter(Boolean);
                // "Putar" means play now, not append to the end of the queue.
                const r = await pc.playNow(rows, requester);
                return res.json({ ok: true, track: r });
            }
            const r = await ctx.enqueue(query, requester);
            res.json({ ok: true, track: r });
        } catch (e) {
            console.error("api/play:", e.message);
            res.status(400).json({ error: e.message });
        }
    });

    app.post("/api/skip", async (_req, res) => {
        try {
            if (pc) return res.json({ ok: true, ...(await pc.next()) ?? {} });
            res.json(await ctx.skipTrack());
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post("/api/stop", async (_req, res) => {
        try {
            if (pc) {
                await pc.stop();
                // Match legacy Stop behavior: also leave the voice channel.
                try { await ctx.leaveVC(true); } catch {}
                return res.json({ ok: true });
            }
            await ctx.stopAll(false);
            try { await ctx.leaveVC(true); } catch {}
            res.json({ ok: true });
        }
        catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post("/api/pause", async (_req, res) => {
        try {
            if (pc) return res.json({ ok: true, ...(await pc.togglePause()) });
            if (!ctx.getPlayer()) return res.json({ ok: true, paused: false, note: "no player" });
            const r = await ctx.togglePause();
            res.json({ ok: true, ...r });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post("/api/volume", async (req, res) => {
        try {
            if (pc) return res.json({ ok: true, ...(await pc.setVolume(req.body?.volume ?? 100)) });
            const r = await ctx.setVolume(req.body?.volume ?? 100);
            res.json({ ok: true, ...r });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post("/api/loop", async (req, res) => {
        try {
            const explicit = (req.body && Number.isInteger(req.body.mode));
            if (pc) {
                const r = explicit ? pc.setLoop(req.body.mode) : pc.cycleLoop();
                return res.json({ ok: true, ...r });
            }
            const r = explicit ? await ctx.setLoop(req.body.mode) : await ctx.cycleLoop();
            res.json({ ok: true, ...r });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post("/api/clear", async (_req, res) => {
        try {
            if (pc) return res.json({ ok: true, ...pc.clearQueue() });
            res.json({ ok: true, ...(await ctx.clearQueue()) });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.delete("/api/queue/:idx", async (req, res) => {
        try {
            const idx = Number(req.params.idx);
            // Dashboard indices start at the current track (0); the controller
            // keeps played entries internally for QUEUE loop / history.
            if (pc) return res.json({ ok: true, ...pc.removeAt(pc.fromUiIndex(idx)) });
            const r = await ctx.removeAt(idx);
            res.json({ ok: true, ...r });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // === New library / download / queue endpoints ===
    app.post("/api/search", async (req, res) => {
        try {
            const query = String(req.body?.query || "").trim();
            if (!query) return res.status(400).json({ error: "Query required" });
            const requester = req.body?.requester || "Web";
            const infos = await searchTracksFn(query, requester);
            if (!infos || !infos.length) return res.status(404).json({ error: "No results" });
            const out = infos.map((info) => {
                const row = lib.upsertFromLavalink(info);
                const t = serializeApiTrack(row);
                t.downloading = dl.isDownloading(row.id);
                return t;
            });
            res.json(out);
        } catch (e) {
            console.error("api/search:", e.message);
            res.status(400).json({ error: e.message });
        }
    });

    app.get("/api/library/tracks", (req, res) => {
        try {
            const limit = parseInt(req.query.limit, 10);
            const offset = parseInt(req.query.offset, 10);
            const { tracks, total } = lib.list({
                query: typeof req.query.query === "string" ? req.query.query : undefined,
                filter: req.query.filter || "all",
                limit: Number.isInteger(limit) && limit >= 0 ? limit : 50,
                offset: Number.isInteger(offset) && offset >= 0 ? offset : 0,
            });
            res.json({
                tracks: tracks.map((row) => {
                    const t = serializeApiTrack(row);
                    t.downloading = dl.isDownloading(row.id);
                    return t;
                }),
                total,
            });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post("/api/library/upload", (req, res) => {
        uploads.handleUpload(req, res);
    });

    app.delete("/api/library/tracks/:id/file", (req, res) => {
        try {
            const row = lib.removeFile(Number(req.params.id));
            if (!row) return res.status(404).json({ error: "Track not found" });
            res.json({ ok: true });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.delete("/api/library/tracks/:id", (req, res) => {
        try {
            const id = Number(req.params.id);
            if (pc && pc.isPlayingTrack(id)) {
                return res.status(400).json({ error: "Cannot delete currently playing track" });
            }
            lib.remove(id);
            res.json({ ok: true });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.get("/api/library/tracks/:id/cover", (req, res) => {
        try {
            const row = lib.getById(Number(req.params.id));
            if (!row || !row.cover_path) {
                return res.status(404).json({ error: "Cover not found" });
            }
            const coverPath = lib.resolveCoverPath(row.cover_path);
            if (!require("fs").existsSync(coverPath)) {
                return res.status(404).json({ error: "Cover not found" });
            }
            res.sendFile(coverPath);
        } catch (e) { res.status(404).json({ error: "Cover not found" }); }
    });

    app.post("/api/downloads", (req, res) => {
        try {
            // yt-dlp downloads straight from the URL already stored in tracks.uri,
            // so a Lavalink node is NOT required — downloads stay available in
            // offline mode.
            const ids = req.body?.trackIds;
            if (!Array.isArray(ids) || !ids.every((n) => Number.isInteger(n))) {
                return res.status(400).json({ error: "trackIds must be an array of integers" });
            }
            const queued = dl.enqueue(ids);
            res.json({ ok: true, queued });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.get("/api/downloads", (_req, res) => {
        res.json({ downloads: dl.list() });
    });

    app.delete("/api/downloads/:id", (req, res) => {
        try {
            dl.cancel(Number(req.params.id));
            res.json({ ok: true });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post("/api/queue/add", async (req, res) => {
        try {
            const ids = req.body?.trackIds;
            if (!Array.isArray(ids) || !ids.every((n) => Number.isInteger(n))) {
                return res.status(400).json({ error: "trackIds must be an array of integers" });
            }
            const requester = req.body?.requester || "Web";
            const tracks = ids.map((id) => lib.getById(id)).filter(Boolean);
            if (!tracks.length) return res.status(404).json({ error: "No valid tracks found" });
            if (!pc) return res.status(503).json({ error: "Player controller not available" });
            await pc.enqueue(tracks, requester);
            res.json({ ok: true, count: tracks.length });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post("/api/queue/play-now", async (req, res) => {
        try {
            const ids = req.body?.trackIds;
            if (!Array.isArray(ids) || !ids.every((n) => Number.isInteger(n))) {
                return res.status(400).json({ error: "trackIds must be an array of integers" });
            }
            const requester = req.body?.requester || "Web";
            const tracks = ids.map((id) => lib.getById(id)).filter(Boolean);
            if (!tracks.length) return res.status(404).json({ error: "No valid tracks found" });
            if (!pc) return res.status(503).json({ error: "Player controller not available" });
            const r = await pc.playNow(tracks, requester);
            res.json({ ok: true, count: tracks.length, ...r });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // === Tahap 2: Play Next, Shuffle, Queue Reorder, Jump ===
    app.post("/api/queue/play-next", async (req, res) => {
        try {
            const ids = req.body?.trackIds;
            if (!Array.isArray(ids) || !ids.every((n) => Number.isInteger(n))) {
                return res.status(400).json({ error: "trackIds must be an array of integers" });
            }
            const requester = req.body?.requester || "Web";
            const tracks = ids.map((id) => lib.getById(id)).filter(Boolean);
            if (!tracks.length) return res.status(404).json({ error: "No valid tracks found" });
            if (!pc) return res.status(503).json({ error: "Player controller not available" });
            const r = pc.playNext(tracks, requester);
            res.json({ ok: true, ...r });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post("/api/queue/shuffle", (_req, res) => {
        try {
            if (!pc) return res.status(503).json({ error: "Player controller not available" });
            res.json({ ok: true, ...pc.shuffle() });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post("/api/queue/reorder", (req, res) => {
        try {
            const { oldIndex, newIndex } = req.body || {};
            if (!pc) return res.status(503).json({ error: "Player controller not available" });
            res.json({ ok: true, ...pc.reorder(pc.fromUiIndex(oldIndex), pc.fromUiIndex(newIndex)) });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post("/api/queue/jump", async (req, res) => {
        try {
            const { index } = req.body || {};
            if (!pc) return res.status(503).json({ error: "Player controller not available" });
            await pc.jumpTo(pc.fromUiIndex(index));
            res.json({ ok: true, index: Number(index) });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // === Tahap 2: Playlists API ===
    app.get("/api/playlists", (req, res) => {
        try {
            const limit = parseInt(req.query.limit, 10);
            const offset = parseInt(req.query.offset, 10);
            res.json(pl.listPlaylists({ limit, offset }));
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post("/api/playlists", (req, res) => {
        try {
            const { name, description } = req.body || {};
            const created = pl.createPlaylist(name, description);
            res.status(201).json({ ok: true, playlist: created });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.get("/api/playlists/:id", (req, res) => {
        try {
            const playlist = pl.getPlaylistById(Number(req.params.id));
            if (!playlist) return res.status(404).json({ error: "Playlist not found" });
            res.json({ ok: true, playlist });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.patch("/api/playlists/:id", (req, res) => {
        try {
            const updated = pl.updatePlaylist(Number(req.params.id), req.body || {});
            res.json({ ok: true, playlist: updated });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.delete("/api/playlists/:id", (req, res) => {
        try {
            const r = pl.deletePlaylist(Number(req.params.id));
            if (!r.deleted) return res.status(404).json({ error: "Playlist not found" });
            res.json({ ok: true });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.get("/api/playlists/:id/tracks", (req, res) => {
        try {
            res.json(pl.getPlaylistTracks(Number(req.params.id)));
        } catch (e) { res.status(404).json({ error: e.message }); }
    });

    app.post("/api/playlists/:id/tracks", (req, res) => {
        try {
            const { trackId } = req.body || {};
            const r = pl.addTrackToPlaylist(Number(req.params.id), Number(trackId));
            res.json({ ok: true, ...r });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.delete("/api/playlists/:id/tracks/:trackId", (req, res) => {
        try {
            const r = pl.removeTrackFromPlaylist(Number(req.params.id), Number(req.params.trackId));
            res.json({ ok: true, ...r });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post("/api/playlists/:id/reorder", (req, res) => {
        try {
            const { trackIdsOrder } = req.body || {};
            const r = pl.reorderPlaylistTracks(Number(req.params.id), trackIdsOrder);
            res.json({ ok: true, ...r });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // === Tahap 2: Likes API ===
    app.get("/api/likes", (req, res) => {
        try {
            const limit = parseInt(req.query.limit, 10);
            const offset = parseInt(req.query.offset, 10);
            res.json(lk.listLikes({ limit, offset }));
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post("/api/likes/:trackId", (req, res) => {
        try {
            const r = lk.toggleLike(Number(req.params.trackId));
            res.json({ ok: true, ...r });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.get("/api/likes/:trackId", (req, res) => {
        try {
            const liked = lk.isLiked(Number(req.params.trackId));
            res.json({ liked, track_id: Number(req.params.trackId) });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // === Tahap 2: History API ===
    app.get("/api/history", (req, res) => {
        try {
            const limit = parseInt(req.query.limit, 10);
            const offset = parseInt(req.query.offset, 10);
            res.json(hist.listHistory({ limit, offset }));
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // === Tahap 4: Autoplay & Recommendations API ===
    app.get("/api/recommendations", async (req, res) => {
        try {
            const limit = parseInt(req.query.limit, 10) || 10;
            const currentTrackId = req.query.currentTrackId ? Number(req.query.currentTrackId) : null;
            const currentTrack = currentTrackId ? lib.getById(currentTrackId) : null;
            const recs = await rec.getRecommendations(currentTrack, { limit });
            res.json({ recommendations: recs });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post("/api/autoplay", async (req, res) => {
        try {
            if (!pc) return res.status(503).json({ error: "Player controller not available" });
            const enable = req.body?.enabled;
            if (typeof enable === "boolean") {
                pc.autoplayEnabled = enable;
                return res.json({ ok: true, autoplayEnabled: pc.autoplayEnabled });
            }
            // Manual trigger: queue one recommendation
            const currentTrack = stateMod.State.playing;
            const nextTrack = await rec.getAutoplayRecommendations(currentTrack ? { id: currentTrack.id, title: currentTrack.title, artist: currentTrack.author } : null, { count: 1 });
            if (!nextTrack.length) return res.status(404).json({ error: "No recommendations available" });
            await pc.playNext(nextTrack, "Autoplay");
            res.json({ ok: true, queued: nextTrack });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post("/api/settings", async (req, res) => {
        try {
            const r = await ctx.applyRuntimeConfig(req.body || {});
            const rt = ctx.RuntimeSnapshot();
            res.json({ ok: true, changed: r.changed !== false, config: cfg.publicConfig(rt) });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // === HTTP + WS ===
    const server = http.createServer(app);
    const wss = new WebSocketServer({ server });
    ctx.wss = wss;
    broadcaster.attach(wss);
    // (Removed unused seq counter — the WebSocket payload already carries 'tag'.)
    wss.on("connection", (ws) => {
        console.log("🔌 Dashboard connected");
        try { ws.send(JSON.stringify({ type: "state", tag: "init", data: stateMod.snapshot() })); } catch {}
    });
    server.on("close", () => broadcaster.stop());

    // Real state changes (play, stop, queue ops, etc.) — coalesced into one
    // serialization per window instead of one per mutation.
    stateMod.emitter.on("change", onChange);
    // Position ticks — same coalescing path, lower priority tag.
    stateMod.emitter.on("tick", () => broadcaster.request("tick"));

    // Streaming endpoint for local library files (used by internal Lavalink playback)
    app.get("/api/stream/:id", (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isInteger(id)) return res.status(400).send("Invalid track ID");
            const row = lib.getById(id);
            if (!row || !row.file_path) return res.status(404).send("File not found");
            const filePath = lib.resolveFilePath(row.file_path);
            if (!require("fs").existsSync(filePath)) return res.status(404).send("File missing on disk");

            const fs = require("fs");
            const stat = fs.statSync(filePath);
            const fileSize = stat.size;
            const range = req.headers.range;

            if (range) {
                const parts = range.replace(/bytes=/, "").split("-");
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const chunksize = (end - start) + 1;
                const file = fs.createReadStream(filePath, { start, end });
                const head = {
                    "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                    "Accept-Ranges": "bytes",
                    "Content-Length": chunksize,
                    "Content-Type": row.format === "webm" ? "audio/webm" : (row.format === "ogg" || row.format === "opus" ? "audio/ogg" : "audio/mpeg"),
                };
                res.writeHead(206, head);
                file.pipe(res);
            } else {
                const head = {
                    "Content-Length": fileSize,
                    "Content-Type": row.format === "webm" ? "audio/webm" : (row.format === "ogg" || row.format === "opus" ? "audio/ogg" : "audio/mpeg"),
                    "Accept-Ranges": "bytes",
                };
                res.writeHead(200, head);
                fs.createReadStream(filePath).pipe(res);
            }
        } catch (e) {
            console.error("api/stream error:", e.message);
            res.status(500).send("Stream error");
        }
    });

    return { app, server };
}

module.exports = { buildServer };
