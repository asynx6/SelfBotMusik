"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Database = require("better-sqlite3");
const jwt = require("jsonwebtoken");

// ---- Stub the database module before requiring webserver/auth/library. ----
const dbModulePath = require.resolve("../modules/database");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbm-webapi-"));
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
        getAllSettings: () => {
            const out = {};
            for (const r of testDb.prepare("SELECT key, value FROM settings").all()) out[r.key] = r.value;
            return out;
        },
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
const library = require("../modules/library");
const { PlayerController } = require("../modules/player-controller");
const { BaseEngine } = require("../modules/engines/base");
const { buildServer } = require("../modules/webserver");

const JWT_SECRET = testDb.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get().value;
const AUTH_COOKIE = "auth_token=" + jwt.sign({ sub: "admin", role: "admin", ts: Date.now() }, JWT_SECRET, { expiresIn: 3600 });

// ---- Mock downloads service ----
function createMockDownloads() {
    const rows = [];
    return {
        rows,
        enqueued: [],
        canceled: [],
        isDownloading: (trackId) => rows.some((r) => r.track_id === trackId && r.status !== "done"),
        enqueue(trackIds) {
            for (const id of trackIds) this.enqueued.push(id);
            for (const id of trackIds) {
                rows.push({ id: rows.length + 1, track_id: id, status: "queued", progress: 0 });
            }
            return rows.slice(-trackIds.length);
        },
        list: () => rows,
        cancel(id) {
            const row = rows.find((r) => r.id === id);
            if (!row) throw new Error("Download not found: " + id);
            row.status = "canceled";
            this.canceled.push(id);
            return { ok: true };
        },
    };
}

// ---- Mock engine (plays local tracks only) ----
class MockEngine extends BaseEngine {
    constructor() {
        super();
        this.played = [];
        this.stopped = false;
    }
    async play(track) { this.played.push(track); }
    async pause() { this.paused = true; }
    async resume() { this.paused = false; }
    async stop() { this.stopped = true; }
    async setVolume(v) { this.volume = v; }
    getPositionMs() { return 0; }
    async destroy() {}
}

// ---- Build server under test ----
const downloads = createMockDownloads();
let searchResults = [];

const controller = new PlayerController({
    dataDir: tmpDir,
    createLocalEngine: () => new MockEngine(),
    createLavalinkEngine: () => { throw new Error("lavalink not available in test"); },
    isLavalinkReady: () => false,
    db: testDb,
});

const ctx = {
    library,
    downloads,
    playerController: controller,
    searchTracks: async (query) => searchResults,
    RuntimeSnapshot: () => ({}),
    syncStateFromPlayer: () => {},
    getPlayer: () => null,
    wss: null,
};

const { server } = buildServer(ctx);
server.listen(0, "127.0.0.1");

async function request(method, url, body) {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: {
            cookie: AUTH_COOKIE,
            "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
}

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// ---- Helpers to seed tracks ----
function seedLavalinkTrack(identifier, title, extra = {}) {
    return library.upsertFromLavalink({
        sourceName: "youtube",
        identifier,
        title,
        author: extra.author || "Tester",
        length: extra.length ?? 100000,
        uri: extra.uri ?? `https://youtube.com/watch?v=${identifier}`,
    });
}

test("POST /api/search upserts tracks and returns downloaded/downloading flags", async () => {
    searchResults = [
        { sourceName: "youtube", identifier: "vid1", title: "Search Hit One", author: "A", length: 90000, uri: "u1" },
        { sourceName: "youtube", identifier: "vid2", title: "Search Hit Two", author: "B", length: 80000, uri: "u2" },
    ];
    const res = await request("POST", "/api/search", { query: "search hits" });
    assert.equal(res.status, 200);
    assert.equal(res.json.length, 2);
    for (const t of res.json) {
        assert.ok(t.id > 0);
        assert.equal(typeof t.downloaded, "boolean");
        assert.equal(typeof t.downloading, "boolean");
        assert.ok(t.title);
        assert.ok(t.duration);
        assert.ok(t.uri);
    }
    assert.equal(res.json[0].title, "Search Hit One");
    // Rows actually persisted
    assert.ok(library.findBySourceKey("youtube:vid1"));
    assert.ok(library.findBySourceKey("youtube:vid2"));

    // downloading flag reflects downloads service
    downloads.rows.push({ id: 99, track_id: res.json[0].id, status: "running", progress: 0.5 });
    const res2 = await request("POST", "/api/search", { query: "search hits" });
    const first = res2.json.find((t) => t.title === "Search Hit One");
    assert.equal(first.downloading, true);
    downloads.rows.length = 0;
});

test("GET /api/library/tracks supports filtering and pagination", async () => {
    const t1 = library.findBySourceKey("youtube:vid1");
    const t2 = library.findBySourceKey("youtube:vid2");

    // Make t1 local by attaching a file
    const fileName = `${t1.id}.mp3`;
    fs.writeFileSync(path.join(library.getLibraryDir(), fileName), "dummy");
    library.attachFile(t1.id, { filePath: fileName, fileSize: 5, format: "mp3", sha256: "hash-t1" });

    const all = await request("GET", "/api/library/tracks");
    assert.equal(all.status, 200);
    assert.ok(all.json.total >= 2);
    const one = all.json.tracks.find((t) => t.id === t1.id);
    assert.equal(one.downloaded, true);
    assert.equal(one.downloading, false);

    const local = await request("GET", "/api/library/tracks?filter=local");
    assert.ok(local.json.tracks.every((t) => t.downloaded === true));
    assert.ok(local.json.tracks.some((t) => t.id === t1.id));

    const paged = await request("GET", "/api/library/tracks?limit=1&offset=0");
    assert.equal(paged.json.tracks.length, 1);
    assert.ok(paged.json.total >= 2);

    const queried = await request("GET", "/api/library/tracks?query=" + encodeURIComponent("Hit Two"));
    assert.equal(queried.json.total, 1);
    assert.equal(queried.json.tracks[0].id, t2.id);
});

test("POST /api/downloads enqueues and GET /api/downloads lists status", async () => {
    const t2 = library.findBySourceKey("youtube:vid2");
    const post = await request("POST", "/api/downloads", { trackIds: [t2.id] });
    assert.equal(post.status, 200);
    assert.equal(post.json.ok, true);
    assert.ok(Array.isArray(post.json.queued));
    assert.deepEqual(downloads.enqueued, [t2.id]);

    const get = await request("GET", "/api/downloads");
    assert.equal(get.status, 200);
    assert.ok(Array.isArray(get.json.downloads));
    assert.ok(get.json.downloads.some((d) => d.track_id === t2.id));

    // Validation: non-integer / non-array rejected
    const bad1 = await request("POST", "/api/downloads", { trackIds: "nope" });
    assert.equal(bad1.status, 400);
    const bad2 = await request("POST", "/api/downloads", { trackIds: [1.5] });
    assert.equal(bad2.status, 400);

    // Cancel
    const dlId = get.json.downloads[0].id;
    const del = await request("DELETE", `/api/downloads/${dlId}`);
    assert.equal(del.status, 200);
    assert.deepEqual(downloads.canceled, [dlId]);
});

test("POST /api/queue/add enqueues tracks into PlayerController", async () => {
    const t2 = library.findBySourceKey("youtube:vid2");
    // Make it playable (local) so the controller keeps it in the queue.
    const fname2 = `${t2.id}.mp3`;
    fs.writeFileSync(path.join(library.getLibraryDir(), fname2), "dummy-local");
    library.attachFile(t2.id, { filePath: fname2, fileSize: 11, format: "mp3", sha256: "hash-t2" });

    const res = await request("POST", "/api/queue/add", { trackIds: [t2.id], requester: "Tester" });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.count, 1);
    assert.equal(controller.queue.length, 1);
    assert.equal(controller.queue[0].requester, "Tester");

    // Validation
    const bad = await request("POST", "/api/queue/add", { trackIds: ["x"] });
    assert.equal(bad.status, 400);
});

test("DELETE /api/library/tracks/:id blocks playing track, deletes otherwise", async () => {
    // Currently playing = index 0 (from queue/add test)
    const t2 = library.findBySourceKey("youtube:vid2");
    const blocked = await request("DELETE", `/api/library/tracks/${t2.id}`);
    assert.equal(blocked.status, 400);
    assert.equal(blocked.json.error, "Cannot delete currently playing track");

    const fresh = seedLavalinkTrack("deleteme", "Delete Me");
    const ok = await request("DELETE", `/api/library/tracks/${fresh.id}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(library.getById(fresh.id), null);
});

test("DELETE /api/library/tracks/:id/file removes file but keeps row", async () => {
    const t1 = library.findBySourceKey("youtube:vid1");
    assert.ok(t1.file_path);
    const res = await request("DELETE", `/api/library/tracks/${t1.id}/file`);
    assert.equal(res.status, 200);
    const after = library.getById(t1.id);
    assert.ok(after, "row kept");
    assert.equal(after.file_path, null);
    // 404 for unknown track
    const nf = await request("DELETE", "/api/library/tracks/999999/file");
    assert.equal(nf.status, 404);
});

test("GET /api/library/tracks/:id/cover serves cover or 404s", async () => {
    const t2 = library.findBySourceKey("youtube:vid2");
    // No cover yet -> 404
    const nf = await request("GET", `/api/library/tracks/${t2.id}/cover`);
    assert.equal(nf.status, 404);
    assert.equal(nf.json.error, "Cover not found");

    // Add a cover file
    const coverName = `${t2.id}.jpg`;
    fs.writeFileSync(path.join(library.getCoversDir(), coverName), "fakejpg");
    testDb.prepare("UPDATE tracks SET cover_path = ? WHERE id = ?").run(coverName, t2.id);
    const ok = await request("GET", `/api/library/tracks/${t2.id}/cover`);
    assert.equal(ok.status, 200);
});

test("Legacy endpoints route through PlayerController", async () => {
    // skip -> next(); queue currently has 1 playing item; skip with loop OFF empties queue
    const skip = await request("POST", "/api/skip");
    assert.equal(skip.status, 200);
    // Queue exhausted -> stop() called, queue empty
    assert.equal(controller.queue.length, 0);
    assert.equal(controller.currentIndex, -1);

    // Enqueue a real playable local track so engine exists
    const t1 = library.findBySourceKey("youtube:vid1");
    const fileName = `${t1.id}.mp3`;
    fs.writeFileSync(path.join(library.getLibraryDir(), fileName), "dummy2");
    library.attachFile(t1.id, { filePath: fileName, fileSize: 6, format: "mp3", sha256: "hash-t1b" });

    const add = await request("POST", "/api/queue/add", { trackIds: [t1.id] });
    assert.equal(add.status, 200);
    assert.ok(controller.currentEngine, "engine active");

    const paused = await request("POST", "/api/pause");
    assert.equal(paused.status, 200);
    assert.equal(paused.json.ok, true);
    assert.equal(paused.json.paused, true);

    const vol = await request("POST", "/api/volume", { volume: 42 });
    assert.equal(vol.status, 200);
    assert.equal(controller.volume, 42);

    const loop = await request("POST", "/api/loop", { mode: 2 });
    assert.equal(loop.status, 200);
    assert.equal(controller.loop, 2);

    const clear = await request("POST", "/api/clear");
    assert.equal(clear.status, 200);
    assert.equal(clear.json.ok, true);

    // Reset to idle so the next enqueue starts fresh.
    await controller.stop();

    // Re-add two tracks and remove one by index
    const t2 = library.findBySourceKey("youtube:vid2");
    await request("POST", "/api/queue/add", { trackIds: [t1.id, t2.id] });
    const rm = await request("DELETE", "/api/queue/1");
    assert.equal(rm.status, 200);
    assert.equal(controller.queue.length, 1);

    const stop = await request("POST", "/api/stop");
    assert.equal(stop.status, 200);
    assert.equal(controller.queue.length, 0);
    assert.equal(controller.currentIndex, -1);
});

test("POST /api/play resolves via search, upserts, and enqueues through controller", async () => {
    // Reset to OFF loop: the "playme" search track has no local file and
    // Lavalink is unavailable here, so the controller would otherwise
    // recurse forever on the QUEUE-loop wrap (known Task 7 bug, see report).
    await request("POST", "/api/loop", { mode: 0 });
    searchResults = [
        { sourceName: "youtube", identifier: "playme", title: "Play Me", author: "C", length: 70000, uri: "up" },
    ];
    const res = await request("POST", "/api/play", { query: "play me", requester: "WebUser" });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    const row = library.findBySourceKey("youtube:playme");
    assert.ok(row);
    // Track has no local file and Lavalink is unavailable, so the controller
    // skips it and stops (loop OFF) — the important part is that the row was
    // upserted and the enqueue went through the controller without error.
    assert.equal(controller.queue.length, 0);
    await controller.stop();
    searchResults = [];
});

test("API requires auth cookie", async () => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/library/tracks`);
    assert.equal(res.status, 401);
});
