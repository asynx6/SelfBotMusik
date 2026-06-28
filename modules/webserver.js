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

// Build the full Express app + HTTP server + WebSocket bridge.
// ctx exposes: enqueue/skip/stop/pause/setVolume/cycleLoop/setLoop/removeAt/clearQueue,
//              joinVC, leaveVC, ensurePoru, Runtime, getPlayer, stopAll, removePoruNode
function buildServer(ctx) {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());

    // Broadcast to all WS clients when state changes.
    function broadcast(seq) {
        let count = 0;
        if (!ctx.wss) return 0;
        for (const c of ctx.wss.clients) {
            if (c.readyState === 1) {
                try { c.send(JSON.stringify({ type: "state", seq, data: stateMod.snapshot() })); count++; } catch {}
            }
        }
        return count;
    }

    // --- Auth gate: all /api/* except /api/auth/* need a valid JWT cookie. ---
    app.use("/api", (req, res, next) => {
        if (req.path.startsWith("/auth/") || req.path === "/auth") return next();
        if (auth.verifyToken(req)) return next();
        res.status(401).json({ error: "Unauthorized", unAuthed: true });
    });

    // --- Custom HTML gate: protect the dashboard at "/" BEFORE static serves index.html. ---
    app.get("/", (req, res, next) => {
        if (auth.verifyToken(req)) return next();
        return res.redirect("/login");
    });

    // --- Login + static files serving. ---
    app.get("/login", (_req, res) => {
        res.sendFile(path.join(__dirname, "..", "public", "login.html"));
    });
    app.use(express.static(path.join(__dirname, "..", "public")));

    // === Auth endpoints ===
    app.get("/api/auth/status", (req, res) => {
        const rt = ctx.RuntimeSnapshot();
        const needsSetup = !rt.lavaHost || !rt.lavaPass
            || !rt.guildId || !rt.channelId;
        if (req.query.whoami === "1") {
            return res.json({ authed: auth.verifyToken(req), role: auth.verifyToken(req) ? "admin" : null });
        }
        res.json({ authed: auth.verifyToken(req), needsSetup });
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
                return res.status(400).json({ error: "Set Guild + Voice Channel in Settings first" });
            }
            try { await ctx.ensurePoru(); } catch (e) {
                return res.status(400).json({ error: e.message });
            }
            const t0 = Date.now();
            while (!stateMod.State.connected && Date.now() - t0 < 15000) {
                await new Promise((r) => setTimeout(r, 200));
            }
            if (!stateMod.State.connected) return res.status(503).json({ error: "Lavalink did not connect (15s timeout)" });
            await ctx.joinVC(rt.guildId, rt.channelId);
            console.log(`🔌 Manual connect → guild=${rt.guildId} channel=${rt.channelId}`);
            res.json({ ok: true });
        } catch (e) {
            console.error("api/connect:", e);
            res.status(500).json({ error: e.message });
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

    app.post("/api/play", async (req, res) => {
        try {
            const r = await ctx.enqueue(req.body?.query || "", req.body?.requester || "Web");
            res.json({ ok: true, track: r });
        } catch (e) {
            console.error("api/play:", e.message);
            res.status(400).json({ error: e.message });
        }
    });

    app.post("/api/skip", async (_req, res) => {
        try { res.json(await ctx.skipTrack()); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post("/api/stop", async (_req, res) => {
        try { await ctx.stopAll(false); res.json({ ok: true }); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post("/api/pause", async (_req, res) => {
        try {
            if (!ctx.getPlayer()) return res.json({ ok: true, paused: false, note: "no player" });
            const r = await ctx.togglePause();
            res.json({ ok: true, ...r });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post("/api/volume", async (req, res) => {
        try {
            const r = await ctx.setVolume(req.body?.volume ?? 100);
            res.json({ ok: true, ...r });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post("/api/loop", async (req, res) => {
        try {
            const explicit = (req.body && Number.isInteger(req.body.mode));
            const r = explicit ? await ctx.setLoop(req.body.mode) : await ctx.cycleLoop();
            res.json({ ok: true, ...r });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post("/api/clear", async (_req, res) => {
        try { res.json({ ok: true, ...(await ctx.clearQueue()) }); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.delete("/api/queue/:idx", async (req, res) => {
        try {
            const idx = Number(req.params.idx);
            const r = await ctx.removeAt(idx);
            res.json({ ok: true, ...r });
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
    let seq = 0;

    wss.on("connection", (ws) => {
        console.log("🔌 Dashboard connected");
        try { ws.send(JSON.stringify({ type: "state", seq: ++seq, data: stateMod.snapshot() })); } catch {}
    });

    // Heartbeat: every state change (and each WS tick) we re-broadcast.
    stateMod.emitter.on("changed", () => {
        const sent = broadcast(++seq);
        if (sent > 0) console.log(`📡 Broadcast → ${sent} client${sent === 1 ? "" : "s"}`);
    });

    return { app, server };
}

module.exports = { buildServer };
