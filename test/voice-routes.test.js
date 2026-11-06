"use strict";

/**
 * Voice session routes: /api/connect and /api/disconnect.
 *
 * These are the two dashboard buttons that were broken:
 *   - "Putuskan Voice" left the bot sitting in the channel, because the
 *     disconnect path only destroyed the Poru (Lavalink) player while the
 *     LocalEngine kept the real @discordjs/voice session alive.
 *   - "Hubungkan ke Voice" failed whenever no Lavalink node was configured,
 *     because the route waited on Lavalink before joining.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const jwt = require("jsonwebtoken");

// ---- Stub the database module before requiring webserver/auth. ----
const dbModulePath = require.resolve("../modules/database");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbm-voice-"));
const testDb = new Database(":memory:");
testDb.pragma("foreign_keys = ON");
testDb.exec(require("../modules/database").SCHEMA_SQL);

require.cache[dbModulePath] = {
    id: dbModulePath,
    filename: dbModulePath,
    loaded: true,
    exports: {
        db: testDb,
        SCHEMA_SQL: require("../modules/database").SCHEMA_SQL,
        DATA_DIR: tmpDir,
        getSetting: (k, f = null) => {
            const row = testDb.prepare("SELECT value FROM settings WHERE key = ?").get(k);
            return row ? (row.value ?? f) : f;
        },
        setSetting: (k, v) => {
            testDb.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, String(v));
        },
        getAllSettings: () => ({}),
        audit: () => {},
        ensureJwtSecret: () => {
            let s = testDb.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get()?.value;
            if (!s) {
                s = require("crypto").randomBytes(48).toString("base64url");
                testDb.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('jwt_secret', ?)").run(s);
            }
            return s;
        },
    },
};

const auth = require("../modules/auth");
const stateMod = require("../modules/state");
const { PlayerController } = require("../modules/player-controller");
const { BaseEngine } = require("../modules/engines/base");
const { buildServer } = require("../modules/webserver");

const JWT_SECRET = testDb.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get().value;
const AUTH_COOKIE = "auth_token=" + jwt.sign({ sub: "admin", role: "admin", ts: Date.now() }, JWT_SECRET, { expiresIn: 3600 });

class MockEngine extends BaseEngine {
    constructor() { super(); this.name = "mock"; this.volume = 100; this.destroyed = false; this.stopped = false; }
    async play() {}
    async pause() {}
    async resume() {}
    async stop() { this.stopped = true; }
    async setVolume(v) { this.volume = v; }
    getPositionMs() { return 0; }
    async destroy() { this.destroyed = true; }
}

// Mutable runtime snapshot so a test can flip Lavalink on and off.
const runtime = {
    guildId: "111",
    channelId: "222",
    lavaHost: null,
    lavaPass: null,
};

const calls = { joined: [], left: [], poruEnsured: 0, probeError: null };

const controller = new PlayerController({
    dataDir: tmpDir,
    createLocalEngine: () => new MockEngine(),
    createLavalinkEngine: () => { throw new Error("lavalink not available in test"); },
    isLavalinkReady: () => false,
    db: testDb,
});

const ctx = {
    playerController: controller,
    searchTracks: async () => [],
    RuntimeSnapshot: () => ({ ...runtime }),
    syncStateFromPlayer: () => {},
    getPlayer: () => null,
    probePermissions: async () => {
        if (calls.probeError) throw calls.probeError;
    },
    ensurePoru: async () => { calls.poruEnsured += 1; },
    joinVC: async (guildId, channelId) => { calls.joined.push({ guildId, channelId }); },
    leaveVC: async (force) => { calls.left.push({ force }); },
    wss: null,
};

const { server } = buildServer(ctx);
server.listen(0, "127.0.0.1");

async function request(method, url, body) {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: { cookie: AUTH_COOKIE, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
}

test.before(() => {
    stateMod.patch({ botReady: true });
});

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test("POST /api/connect joins voice even when no Lavalink node is configured", async () => {
    runtime.lavaHost = null;
    runtime.lavaPass = null;
    calls.joined.length = 0;
    calls.poruEnsured = 0;

    const res = await request("POST", "/api/connect");

    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.voiceConnected, true);
    assert.equal(res.json.mode, "local", "without Lavalink the bot joins via @discordjs/voice");
    assert.equal(calls.poruEnsured, 0, "Lavalink must not be required for the join");
    assert.deepEqual(calls.joined, [{ guildId: "111", channelId: "222" }]);
});

test("POST /api/connect still waits for Lavalink when a node IS configured", async () => {
    runtime.lavaHost = "127.0.0.1";
    runtime.lavaPass = "secret";
    calls.joined.length = 0;
    calls.poruEnsured = 0;
    // Simulate the Lavalink node coming up, otherwise the route waits out its
    // 15s timeout on purpose.
    stateMod.patch({ connected: true });

    const res = await request("POST", "/api/connect");

    assert.equal(res.status, 200, res.text);
    assert.equal(calls.poruEnsured, 1, "a configured Lavalink node must be initialised");
    assert.equal(res.json.mode, "lavalink");
    assert.equal(calls.joined.length, 1);

    stateMod.patch({ connected: false });
    runtime.lavaHost = null;
    runtime.lavaPass = null;
});

test("POST /api/connect refuses without a guild/channel and before a permission probe", async () => {
    const saved = { ...runtime };
    runtime.guildId = null;
    runtime.channelId = null;
    calls.joined.length = 0;

    const missing = await request("POST", "/api/connect");
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, "MISSING_IDS");
    assert.equal(calls.joined.length, 0, "must not attempt a join without ids");

    Object.assign(runtime, saved);

    const probeError = new Error("Missing permission to join a voice channel");
    probeError.code = "NO_PERMISSION";
    calls.probeError = probeError;
    calls.joined.length = 0;

    const denied = await request("POST", "/api/connect");
    assert.equal(denied.status, 400);
    assert.equal(denied.json.code, "NO_PERMISSION");
    assert.equal(calls.joined.length, 0, "must not join when the probe fails");

    calls.probeError = null;
});

test("POST /api/disconnect asks the runtime to leave the channel (force=true)", async () => {
    calls.left.length = 0;

    const res = await request("POST", "/api/disconnect", { force: true });

    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.ok, true);
    assert.deepEqual(calls.left, [{ force: true }], "the dashboard button disconnects with force");
});

test("disconnecting the controller destroys the engine that owns the voice session", async () => {
    // A real file on disk so the controller resolves this track to the LOCAL
    // engine — the one that owns the @discordjs/voice connection.
    const libDir = path.join(tmpDir, "library");
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(libDir, "local.bin"), "audio");

    await controller.enqueue(
        [{ id: 7, title: "Local Song", uri: "u", encoded: "e", file_path: "local.bin" }],
        "user"
    );
    const engine = controller.currentEngine;
    assert.ok(engine, "engine should be live");
    assert.equal(engine.destroyed, false);

    // This is what index.js leaveVC() now does before tearing down the rest.
    await controller.disconnect();

    assert.equal(engine.destroyed, true, "the engine (voice connection) must be destroyed");
    assert.equal(controller.currentEngine, null);
});
