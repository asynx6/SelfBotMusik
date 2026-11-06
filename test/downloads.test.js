"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const Database = require("better-sqlite3");

const { createDownloadManager } = require("../modules/downloads");

function setupTestEnvironment() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbm-dl-test-"));
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");

    db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE TABLE IF NOT EXISTS tracks (
            id             INTEGER PRIMARY KEY,
            source_key     TEXT UNIQUE NOT NULL,
            source_type    TEXT NOT NULL,
            source_name    TEXT,
            identifier     TEXT,
            title          TEXT NOT NULL,
            artist         TEXT,
            album          TEXT,
            duration_ms    INTEGER,
            uri            TEXT,
            file_path      TEXT,
            file_size      INTEGER,
            format         TEXT,
            sha256         TEXT,
            cover_path     TEXT,
            cover_url      TEXT,
            created_at     INTEGER NOT NULL,
            downloaded_at  INTEGER,
            play_count     INTEGER NOT NULL DEFAULT 0,
            last_played_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS downloads (
            id          INTEGER PRIMARY KEY,
            track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            status      TEXT NOT NULL,
            progress    REAL NOT NULL DEFAULT 0,
            error       TEXT,
            created_at  INTEGER NOT NULL,
            started_at  INTEGER,
            finished_at INTEGER
        );
    `);

    const tracks = new Map();
    let nextTrackId = 1;

    function addTrack({ title = "Test Track", uri = "https://example.com/audio", filePath = null } = {}) {
        const id = nextTrackId++;
        const sourceKey = `test:${id}`;
        const now = Date.now();
        db.prepare(`
            INSERT INTO tracks (id, source_key, source_type, title, uri, file_path, created_at)
            VALUES (?, ?, 'test', ?, ?, ?, ?)
        `).run(id, sourceKey, title, uri, filePath, now);

        const row = { id, source_key: sourceKey, source_type: "test", title, uri, file_path: filePath, created_at: now };
        tracks.set(id, row);
        return row;
    }

    const fakeLibrary = {
        getById(id) {
            return db.prepare("SELECT * FROM tracks WHERE id = ?").get(id) || null;
        },
        attachCalls: [],
        attachFile(id, payload) {
            fakeLibrary.attachCalls.push({ id, payload });
            db.prepare(`
                UPDATE tracks
                SET file_path = ?, file_size = ?, format = ?, sha256 = ?, downloaded_at = ?
                WHERE id = ?
            `).run(payload.filePath, payload.fileSize, payload.format, payload.sha256, Date.now(), id);
            return fakeLibrary.getById(id);
        },
        diskUsageResult: { bytes: 0, mb: 0, gb: 0, count: 0 },
        diskUsage() {
            return Promise.resolve(fakeLibrary.diskUsageResult);
        },
        resolveFilePath(filePath) {
            return path.join(tmpDir, "library", filePath);
        },
    };

    const settings = new Map();
    const fakeDb = {
        db,
        prepare: (...args) => db.prepare(...args),
        exec: (...args) => db.exec(...args),
        getSetting(key, fallback = null) {
            const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
            if (row) return row.value;
            return settings.has(key) ? settings.get(key) : fallback;
        },
        setSetting(key, val) {
            settings.set(key, String(val));
            db.prepare(`
                INSERT INTO settings (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
            `).run(key, String(val));
        },
    };

    return {
        tmpDir,
        db,
        addTrack,
        fakeLibrary,
        fakeDb,
        cleanup() {
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            } catch { /* cleanup */ }
        },
    };
}

function createFakeChild() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal = "SIGTERM") => {
        child.killed = true;
        child.killSignal = signal;
        setImmediate(() => {
            child.emit("close", null, signal);
            child.emit("exit", null, signal);
        });
        return true;
    };
    return child;
}

function waitForCondition(checkFn, timeoutMs = 3000, intervalMs = 10) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        function tick() {
            try {
                const res = checkFn();
                if (res) return resolve(res);
            } catch (err) {
                return reject(err);
            }
            if (Date.now() - start >= timeoutMs) {
                return reject(new Error(`Timed out waiting for condition after ${timeoutMs}ms`));
            }
            setTimeout(tick, intervalMs);
        }
        tick();
    });
}

test("1. enqueue creates queued row and activeForTrack returns it", () => {
    const env = setupTestEnvironment();
    try {
        const track = env.addTrack({ title: "Song 1" });
        const manager = createDownloadManager({
            spawn: () => createFakeChild(),
            library: env.fakeLibrary,
            db: env.fakeDb,
            dataDir: env.tmpDir,
        });

        const rows = manager.enqueue(track.id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].track_id, track.id);
        assert.equal(rows[0].status, "queued");

        const active = manager.activeForTrack(track.id);
        assert.ok(active);
        assert.equal(active.track_id, track.id);
        assert.ok(["queued", "running"].includes(active.status));
        assert.equal(manager.isDownloading(track.id), true);
    } finally {
        env.cleanup();
    }
});

test("2. enqueue twice for same track reuses existing active row", () => {
    const env = setupTestEnvironment();
    try {
        const track = env.addTrack({ title: "Song 2" });
        const manager = createDownloadManager({
            spawn: () => createFakeChild(),
            library: env.fakeLibrary,
            db: env.fakeDb,
            dataDir: env.tmpDir,
        });

        const rows1 = manager.enqueue(track.id);
        const rows2 = manager.enqueue(track.id);

        assert.equal(rows1[0].id, rows2[0].id);
        assert.equal(manager.list().length, 1);
    } finally {
        env.cleanup();
    }
});

test("3. track with existing file gets done status immediately without spawning yt-dlp", () => {
    const env = setupTestEnvironment();
    try {
        const libDir = path.join(env.tmpDir, "library");
        fs.mkdirSync(libDir, { recursive: true });
        const fileName = "99.mp3";
        fs.writeFileSync(path.join(libDir, fileName), "existing audio data");

        const track = env.addTrack({ title: "Existing Song", filePath: fileName });
        let spawnCalls = 0;
        const manager = createDownloadManager({
            spawn: () => {
                spawnCalls++;
                return createFakeChild();
            },
            library: env.fakeLibrary,
            db: env.fakeDb,
            dataDir: env.tmpDir,
        });

        const rows = manager.enqueue(track.id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, "done");
        assert.equal(rows[0].progress, 1);
        assert.equal(spawnCalls, 0);
        assert.equal(manager.activeForTrack(track.id), null);
    } finally {
        env.cleanup();
    }
});

test("4. concurrency limit restricts active yt-dlp processes", async () => {
    const env = setupTestEnvironment();
    try {
        env.fakeDb.setSetting("download_concurrency", "1");
        const track1 = env.addTrack({ title: "Parallel 1" });
        const track2 = env.addTrack({ title: "Parallel 2" });

        const activeChildren = [];
        let totalSpawns = 0;

        const manager = createDownloadManager({
            spawn: () => {
                totalSpawns++;
                const child = createFakeChild();
                activeChildren.push(child);
                return child;
            },
            library: env.fakeLibrary,
            db: env.fakeDb,
            dataDir: env.tmpDir,
        });

        manager.enqueue([track1.id, track2.id]);

        // Wait until first task spawns
        await waitForCondition(() => activeChildren.length === 1);

        assert.equal(activeChildren.length, 1);
        assert.equal(totalSpawns, 1);

        // Finish first child
        const firstChild = activeChildren[0];
        firstChild.emit("close", 0, null);
        firstChild.emit("exit", 0, null);

        // Wait until second task spawns
        await waitForCondition(() => activeChildren.length === 2);

        assert.equal(activeChildren.length, 2);
        assert.equal(totalSpawns, 2);

        // Finish second child
        activeChildren[1].emit("close", 0, null);
        activeChildren[1].emit("exit", 0, null);
    } finally {
        env.cleanup();
    }
});

test("5. retry: failure once retries; failure twice sets failed with error", async () => {
    const env = setupTestEnvironment();
    try {
        const track = env.addTrack({ title: "Retry Song" });
        let spawnCount = 0;

        const manager = createDownloadManager({
            spawn: () => {
                spawnCount++;
                const child = createFakeChild();
                setImmediate(() => {
                    child.stderr.write("ERROR: Video unavailable (yt-dlp simulated failure)\n");
                    child.emit("close", 1, null);
                    child.emit("exit", 1, null);
                });
                return child;
            },
            library: env.fakeLibrary,
            db: env.fakeDb,
            dataDir: env.tmpDir,
        });

        manager.enqueue(track.id);

        // Wait until download reaches terminal state 'failed'
        await waitForCondition(() => {
            const row = manager.list()[0];
            return row && row.status === "failed";
        });

        assert.equal(spawnCount, 2); // Initial attempt + 1 retry
        const dl = manager.list()[0];
        assert.equal(dl.status, "failed");
        assert.ok(dl.error.includes("Video unavailable"));
        assert.ok(dl.error.length <= 300);
        assert.ok(dl.finished_at > 0);
    } finally {
        env.cleanup();
    }
});

test("6. success updates progress, writes file, calls attachFile with sha256 and marks done", async () => {
    const env = setupTestEnvironment();
    try {
        const track = env.addTrack({ title: "Success Song" });
        const dummyAudio = Buffer.from("super-cool-audio-content-12345");
        const expectedSha256 = crypto.createHash("sha256").update(dummyAudio).digest("hex");

        let changeEvents = [];
        const manager = createDownloadManager({
            spawn: (cmd, args) => {
                const child = createFakeChild();
                const outTemplate = args[args.indexOf("-o") + 1];
                const tmpFile = outTemplate.replace("%(ext)s", "mp3");

                setImmediate(() => {
                    // Send progress
                    child.stdout.write("[download]  50.0% of 10.00MiB at 2.00MiB/s ETA 00:05\n");
                    // Write output file in .tmp
                    fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
                    fs.writeFileSync(tmpFile, dummyAudio);

                    setImmediate(() => {
                        child.emit("close", 0, null);
                        child.emit("exit", 0, null);
                    });
                });
                return child;
            },
            library: env.fakeLibrary,
            db: env.fakeDb,
            dataDir: env.tmpDir,
        });

        manager.on("change", (payload) => {
            changeEvents.push(payload);
        });

        const rows = manager.enqueue(track.id);
        const dlId = rows[0].id;

        // Wait until download reaches terminal state 'done'
        await waitForCondition(() => {
            const row = manager.getById(dlId);
            return row && row.status === "done";
        });

        const finalDl = manager.getById(dlId);
        assert.equal(finalDl.status, "done");
        assert.equal(finalDl.progress, 1);
        assert.ok(finalDl.finished_at > 0);

        // Check file was moved to libraryDir
        const targetPath = path.join(env.tmpDir, "library", `${track.id}.mp3`);
        assert.ok(fs.existsSync(targetPath));
        assert.deepEqual(fs.readFileSync(targetPath), dummyAudio);

        // Check library.attachFile was called
        assert.equal(env.fakeLibrary.attachCalls.length, 1);
        const attach = env.fakeLibrary.attachCalls[0];
        assert.equal(attach.id, track.id);
        assert.equal(attach.payload.filePath, `${track.id}.mp3`);
        assert.equal(attach.payload.fileSize, dummyAudio.length);
        assert.equal(attach.payload.format, "mp3");
        assert.equal(attach.payload.sha256, expectedSha256);

        // Verify change events were emitted
        assert.ok(changeEvents.length > 0);
    } finally {
        env.cleanup();
    }
});

test("7. cancel active spawn calls kill and sets canceled status", async () => {
    const env = setupTestEnvironment();
    try {
        const track = env.addTrack({ title: "Cancel Song" });
        let childProcess;

        const manager = createDownloadManager({
            spawn: () => {
                childProcess = createFakeChild();
                return childProcess;
            },
            library: env.fakeLibrary,
            db: env.fakeDb,
            dataDir: env.tmpDir,
        });

        const rows = manager.enqueue(track.id);
        const dlId = rows[0].id;

        await waitForCondition(() => childProcess !== undefined);

        assert.ok(childProcess);
        assert.equal(childProcess.killed, undefined);

        const res = manager.cancel(dlId);
        assert.deepEqual(res, { ok: true });
        assert.equal(childProcess.killed, true);
        assert.equal(childProcess.killSignal, "SIGTERM");

        const canceledRow = manager.getById(dlId);
        assert.equal(canceledRow.status, "canceled");
        assert.ok(canceledRow.finished_at > 0);
    } finally {
        env.cleanup();
    }
});

test("8. quota exceeded fails task immediately without spawning yt-dlp", async () => {
    const env = setupTestEnvironment();
    try {
        env.fakeDb.setSetting("library_quota_gb", "5");
        // Exceed quota: 6 GB in bytes
        env.fakeLibrary.diskUsageResult = {
            bytes: 6 * 1024 * 1024 * 1024,
            mb: 6144,
            gb: 6,
            count: 100,
        };

        const track = env.addTrack({ title: "Quota Song" });
        let spawnCalls = 0;

        const manager = createDownloadManager({
            spawn: () => {
                spawnCalls++;
                return createFakeChild();
            },
            library: env.fakeLibrary,
            db: env.fakeDb,
            dataDir: env.tmpDir,
        });

        const rows = manager.enqueue(track.id);
        const dlId = rows[0].id;

        await waitForCondition(() => {
            const row = manager.getById(dlId);
            return row && row.status === "failed";
        });

        assert.equal(spawnCalls, 0);
        const failedRow = manager.getById(dlId);
        assert.equal(failedRow.status, "failed");
        assert.ok(/kuota|quota/i.test(failedRow.error));
        assert.ok(failedRow.finished_at > 0);
    } finally {
        env.cleanup();
    }
});

test("8b. low free disk space fails the task before yt-dlp writes anything", async () => {
    const previousReserve = process.env.DISK_RESERVE_MB;
    process.env.DISK_RESERVE_MB = "128";
    const env = setupTestEnvironment();
    try {
        env.fakeDb.setSetting("library_quota_gb", "5");
        // 40 MB free is below the 128 MB reserve.
        env.fakeLibrary.freeDiskBytes = async () => 40 * 1024 * 1024;

        const track = env.addTrack({ title: "Tight Disk Song" });
        let spawnCalls = 0;

        const manager = createDownloadManager({
            spawn: () => {
                spawnCalls++;
                return createFakeChild();
            },
            library: env.fakeLibrary,
            db: env.fakeDb,
            dataDir: env.tmpDir,
        });

        const rows = manager.enqueue(track.id);
        const dlId = rows[0].id;

        await waitForCondition(() => {
            const row = manager.getById(dlId);
            return row && row.status === "failed";
        });

        assert.equal(spawnCalls, 0, "yt-dlp must not be started");
        const failedRow = manager.getById(dlId);
        assert.equal(failedRow.status, "failed");
        assert.ok(/disk/i.test(failedRow.error), `expected a disk message, got: ${failedRow.error}`);
    } finally {
        env.cleanup();
        if (previousReserve === undefined) delete process.env.DISK_RESERVE_MB;
        else process.env.DISK_RESERVE_MB = previousReserve;
    }
});

test("9. cancel queued task before it starts running cancels and prevents spawn", async () => {
    const env = setupTestEnvironment();
    try {
        env.fakeDb.setSetting("download_concurrency", "1");
        const track1 = env.addTrack({ title: "Running Task", uri: "https://example.com/audio1" });
        const track2 = env.addTrack({ title: "Queued Task to Cancel", uri: "https://example.com/audio2" });

        let spawnedTrack2 = false;
        let child1;
        const manager = createDownloadManager({
            spawn: (cmd, args) => {
                if (args.includes(track2.uri)) {
                    spawnedTrack2 = true;
                }
                child1 = createFakeChild();
                return child1;
            },
            library: env.fakeLibrary,
            db: env.fakeDb,
            dataDir: env.tmpDir,
        });

        const [r1, r2] = manager.enqueue([track1.id, track2.id]);
        assert.equal(r2.status, "queued");

        // Wait until task 1 spawns
        await waitForCondition(() => child1 !== undefined);

        // Cancel r2 while still queued
        const res = manager.cancel(r2.id);
        assert.deepEqual(res, { ok: true });
        assert.equal(manager.getById(r2.id).status, "canceled");

        // Finish track 1
        child1.emit("close", 0, null);
        child1.emit("exit", 0, null);

        // Wait until track 1 settles
        await waitForCondition(() => {
            const row = manager.getById(r1.id);
            return row && ["done", "failed"].includes(row.status);
        });

        assert.equal(spawnedTrack2, false);
    } finally {
        env.cleanup();
    }
});

test("10. input validation: nonexistent track and invalid cancel operations throw", () => {
    const env = setupTestEnvironment();
    try {
        const manager = createDownloadManager({
            spawn: () => createFakeChild(),
            library: env.fakeLibrary,
            db: env.fakeDb,
            dataDir: env.tmpDir,
        });

        // Enqueue nonexistent track
        assert.throws(() => manager.enqueue(99999), /Track not found: 99999/);

        // Cancel nonexistent download
        assert.throws(() => manager.cancel(88888), /Download not found: 88888/);

        // Cancel already completed download
        const track = env.addTrack({ title: "Done Track" });
        const [row] = manager.enqueue(track.id);
        env.db.prepare("UPDATE downloads SET status = 'done' WHERE id = ?").run(row.id);

        assert.throws(() => manager.cancel(row.id), /Cannot cancel download with status: done/);
    } finally {
        env.cleanup();
    }
});

test("11. default singleton exports all required methods and extends EventEmitter", () => {
    const downloads = require("../modules/downloads");
    assert.equal(typeof downloads.enqueue, "function");
    assert.equal(typeof downloads.list, "function");
    assert.equal(typeof downloads.getById, "function");
    assert.equal(typeof downloads.cancel, "function");
    assert.equal(typeof downloads.activeForTrack, "function");
    assert.equal(typeof downloads.isDownloading, "function");
    assert.equal(typeof downloads.createDownloadManager, "function");
    assert.equal(typeof downloads.on, "function");
    assert.equal(typeof downloads.emit, "function");
});

test("12. cancel queued task while diskUsage is awaiting does not spawn or revive task", async () => {
    const env = setupTestEnvironment();
    try {
        let resolveDiskUsage;
        env.fakeLibrary.diskUsage = () => new Promise((resolve) => {
            resolveDiskUsage = resolve;
        });

        let spawnCalls = 0;
        const manager = createDownloadManager({
            spawn: () => {
                spawnCalls++;
                return createFakeChild();
            },
            library: env.fakeLibrary,
            db: env.fakeDb,
            dataDir: env.tmpDir,
        });

        const track = env.addTrack({ title: "Race Cancel Song" });
        const [row] = manager.enqueue(track.id);

        // Wait until diskUsage hook is active
        await waitForCondition(() => typeof resolveDiskUsage === "function");

        // Cancel while diskUsage is pending
        manager.cancel(row.id);
        assert.equal(manager.getById(row.id).status, "canceled");

        // Now resolve diskUsage
        resolveDiskUsage({ bytes: 0 });

        // Let processQueue ticks proceed
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        // Verify task was NOT revived to running and spawn was not called
        assert.equal(manager.getById(row.id).status, "canceled");
        assert.equal(spawnCalls, 0);
    } finally {
        env.cleanup();
    }
});

test("13. spawn emitting both 'error' and 'close' does not trigger duplicate failure handling", async () => {
    const env = setupTestEnvironment();
    try {
        const track = env.addTrack({ title: "Error Then Close Song" });
        let spawnCalls = 0;

        const manager = createDownloadManager({
            spawn: () => {
                spawnCalls++;
                const child = createFakeChild();
                setImmediate(() => {
                    // Node.js emits error then close on spawn failure (e.g. missing binary)
                    child.emit("error", new Error("spawn ENOENT yt-dlp"));
                    child.emit("close", -2, null);
                });
                return child;
            },
            library: env.fakeLibrary,
            db: env.fakeDb,
            dataDir: env.tmpDir,
        });

        manager.enqueue(track.id);

        await waitForCondition(() => {
            const dl = manager.list()[0];
            return dl && dl.status === "failed";
        });

        // Initial attempt + exactly 1 retry
        assert.equal(spawnCalls, 2);
        const dl = manager.list()[0];
        assert.equal(dl.status, "failed");
        assert.ok(dl.error.includes("spawn ENOENT yt-dlp"));
    } finally {
        env.cleanup();
    }
});


