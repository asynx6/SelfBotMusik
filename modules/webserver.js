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

    // Send a snapshot to all WS clients. The browser only redraws when
    // the payload changes — we don't need to log every heartbeat.
    function push(tag = "update") {
        const payload = JSON.stringify({ type: "state", tag, data: stateMod.snapshot() });
        let count = 0;
        if (!ctx.wss) return 0;
        for (const c of ctx.wss.clients) {
            if (c.readyState === 1) {
                try { c.send(payload); count++; } catch {}
            }
        }
        return count;
    }
    // Coalesce successive change events into one push per 150 ms.
    let pending = null;
    function onChange() {
        push("change");
        if (pending) return;
        pending = setTimeout(() => { pending = null; }, 150);
    }

    // --- Auth gate: all /api/* except /api/auth/* and /api/stream/* need a valid JWT cookie. ---
    app.use("/api", (req, res, next) => {
        if (req.path.startsWith("/auth/") || req.path === "/auth") return next();
        // Allow unauthenticated internal audio streaming for local Lavalink
        if (req.path.startsWith("/stream/")) return next();
        if (auth.verifyToken(req)) return next();
        res.status(401).json({ error: "Unauthorized", unAuthed: true });
    });

    // --- Custom HTML gate: protect the dashboard at "/" BEFORE static serves index.html. ---
    app.get("/", (req, res, next) => {
        if (auth.verifyToken(req)) return next();
        return res.redirect("/login");
    });

    // --- Login + static files serving. ---
    app.get("/login", (req, res) => {
        if (auth.verifyToken(req)) return res.redirect("/");
        res.sendFile(path.join(__dirname, "..", "public", "login.html"));
    });
    app.use(express.static(path.join(__dirname, "..", "public")));

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
            return res.status(429).json({ error: "Too many failed attempts. Try again in 15 minutes." });
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
            try { await ctx.ensurePoru(); } catch (e) {
                return res.status(400).json({ error: e.message, code: e.code || "LAVA" });
            }
            const t0 = Date.now();
            while (!stateMod.State.connected && Date.now() - t0 < 15000) {
                await new Promise((r) => setTimeout(r, 200));
            }
            if (!stateMod.State.connected) return res.status(503).json({ error: "Lavalink did not connect (15s timeout)" });
            // The user wants: connect VC even if there's nothing playing yet.
            // joinVC itself is non-throwing except on permission errors.
            await ctx.joinVC(rt.guildId, rt.channelId);
            console.log(`🔌 Manual connect → guild=${rt.guildId} channel=${rt.channelId}`);
            res.json({ ok: true, guildId: rt.guildId, channelId: rt.channelId, voiceConnected: true });
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
                const rows = tracks.map((info) => lib.findBySourceKey(`${info.sourceName}:${info.identifier}`));
                const r = await pc.enqueue(rows, requester);
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
            if (pc) return res.json({ ok: true, ...pc.removeAt(idx) });
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
            res.json({ ok: true, ...pc.reorder(oldIndex, newIndex) });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post("/api/queue/jump", async (req, res) => {
        try {
            const { index } = req.body || {};
            if (!pc) return res.status(503).json({ error: "Player controller not available" });
            await pc.jumpTo(Number(index));
            res.json({ ok: true, index: pc.currentIndex });
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
    // (Removed unused seq counter — the WebSocket payload already carries 'tag'.)
    wss.on("connection", (ws) => {
        console.log("🔌 Dashboard connected");
        try { ws.send(JSON.stringify({ type: "state", tag: "init", data: stateMod.snapshot() })); } catch {}
    });

    // Real state changes (play, stop, queue ops, etc.) — log once per change.
    stateMod.emitter.on("change", onChange);
    // Tick updates from the 500ms position ticker — silent (no log spam).
    stateMod.emitter.on("tick", () => push("tick"));

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
