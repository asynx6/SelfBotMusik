"use strict";

/**
 * WebSocket contract: the dashboard must receive an initial snapshot and every
 * subsequent state change. Without this, the UI looks frozen — buttons appear
 * to do nothing because nothing ever comes back.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Database = require("better-sqlite3");
const WebSocket = require("ws");

const dbModulePath = require.resolve("../modules/database");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbm-ws-"));
const { SCHEMA_SQL } = require("../modules/database");

const testDb = new Database(":memory:");
testDb.pragma("foreign_keys = ON");
testDb.exec(SCHEMA_SQL);

require.cache[dbModulePath] = {
    id: dbModulePath,
    filename: dbModulePath,
    loaded: true,
    exports: {
        db: testDb,
        SCHEMA_SQL,
        DATA_DIR: tmpDir,
        getSetting: (key, fallback = null) => {
            const row = testDb.prepare("SELECT value FROM settings WHERE key = ?").get(key);
            return row ? (row.value ?? fallback) : fallback;
        },
        setSetting: () => {},
        getAllSettings: () => ({}),
        audit: () => {},
        ensureJwtSecret: () => "test-secret",
    },
};

const stateMod = require("../modules/state");
const { buildServer } = require("../modules/webserver");

const { server } = buildServer({
    RuntimeSnapshot: () => ({}),
    syncStateFromPlayer: () => {},
    getPlayer: () => null,
    searchTracks: async () => [],
});

server.listen(0, "127.0.0.1");

/**
 * Buffered client.
 *
 * The server pushes the initial snapshot the instant the socket opens, which
 * can land in the same I/O tick as the `open` event — before any listener is
 * attached. Buffering from construction removes that race.
 */
function connectClient(port) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const buffered = [];
    const waiters = [];

    socket.on("message", (raw) => {
        let payload;
        try { payload = JSON.parse(raw.toString()); } catch { return; }

        for (let i = 0; i < waiters.length; i += 1) {
            if (waiters[i].predicate(payload)) {
                const [waiter] = waiters.splice(i, 1);
                clearTimeout(waiter.timer);
                waiter.resolve(payload);
                return;
            }
        }
        buffered.push(payload);
    });

    function waitFor(predicate, timeoutMs = 3000) {
        const existing = buffered.findIndex(predicate);
        if (existing >= 0) return Promise.resolve(buffered.splice(existing, 1)[0]);

        return new Promise((resolve, reject) => {
            const waiter = { predicate, resolve };
            waiter.timer = setTimeout(() => {
                const index = waiters.indexOf(waiter);
                if (index >= 0) waiters.splice(index, 1);
                reject(new Error("timed out waiting for a matching frame"));
            }, timeoutMs);
            waiters.push(waiter);
        });
    }

    const ready = new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
    });

    return { socket, ready, waitFor };
}

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test("ws: a new client immediately receives the current state", async () => {
    const { socket, ready, waitFor } = connectClient(server.address().port);
    await ready;

    const frame = await waitFor((m) => m.type === "state");
    assert.equal(frame.tag, "init");
    assert.ok(frame.data, "frame must carry a state payload");
    assert.ok("volume" in frame.data, "state payload must expose volume");
    assert.ok("queue" in frame.data, "state payload must expose the queue");

    socket.close();
});

test("ws: state changes are pushed to connected clients", async () => {
    const { socket, ready, waitFor } = connectClient(server.address().port);
    await ready;
    await waitFor((m) => m.type === "state");

    stateMod.patch({ volume: 42 });

    const frame = await waitFor((m) => m.type === "state" && m.data?.volume === 42);
    assert.equal(frame.data.volume, 42);

    socket.close();
});

test("ws: position ticks reach the client", async () => {
    const { socket, ready, waitFor } = connectClient(server.address().port);
    await ready;
    await waitFor((m) => m.type === "state");

    stateMod.State.position = 0;
    stateMod.tick(() => ({ position: 5000 }));

    const frame = await waitFor((m) => m.type === "state" && m.data?.position === 5000);
    assert.equal(frame.data.position, 5000);

    socket.close();
});
