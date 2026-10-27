"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { PassThrough } = require("node:stream");
const Database = require("better-sqlite3");

const {
    createUploadHandler,
    handleUpload,
    parseAudioFile,
    sha256File
} = require("../modules/uploads");

function createWavBuffer({ durationSeconds = 1, sampleRate = 8000 } = {}) {
    const dataSize = durationSeconds * sampleRate;
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate, 28);
    header.writeUInt16LE(1, 32);
    header.writeUInt16LE(8, 34);
    header.write("data", 36);
    header.writeUInt32LE(dataSize, 40);
    return Buffer.concat([header, Buffer.alloc(dataSize)]);
}

function setupTestEnv() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbm-upload-test-"));
    const libraryDir = path.join(tmpDir, "library");
    const coversDir = path.join(tmpDir, "covers");
    fs.mkdirSync(libraryDir, { recursive: true });
    fs.mkdirSync(coversDir, { recursive: true });

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");

    db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE TABLE IF NOT EXISTS audit_log (
            id      INTEGER PRIMARY KEY,
            ts      INTEGER NOT NULL,
            event   TEXT NOT NULL,
            detail  TEXT
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
    `);

    const fakeLibrary = {
        findBySha256(sha256) {
            if (!sha256) return null;
            return db.prepare("SELECT * FROM tracks WHERE sha256 = ?").get(sha256) || null;
        },
        diskUsageResult: { bytes: 0, mb: 0, gb: 0, count: 0 },
        diskUsage() {
            return Promise.resolve(fakeLibrary.diskUsageResult);
        },
        ALLOWED_AUDIO_EXTENSIONS: new Set([
            "mp3", "m4a", "opus", "ogg", "wav", "flac", "webm", "aac", "oga"
        ]),
        ALLOWED_COVER_EXTENSIONS: new Set(["jpg", "jpeg", "png", "webp", "gif"])
    };

    const auditCalls = [];
    const fakeDb = {
        db,
        prepare: db.prepare.bind(db),
        exec: db.exec.bind(db),
        DATA_DIR: tmpDir,
        getSetting(key, fallback = null) {
            const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
            return row ? (row.value ?? fallback) : fallback;
        },
        setSetting(key, value) {
            db.prepare(`
                INSERT INTO settings (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
            `).run(key, String(value));
        },
        audit(event, detail) {
            auditCalls.push({ event, detail });
            try {
                db.prepare("INSERT INTO audit_log (ts, event, detail) VALUES (?, ?, ?)").run(
                    Date.now(), event, detail ? String(detail) : null
                );
            } catch { /* ignore */ }
        }
    };

    return {
        tmpDir,
        libraryDir,
        coversDir,
        db,
        fakeLibrary,
        fakeDb,
        auditCalls,
        cleanup() {
            try {
                db.close();
                fs.rmSync(tmpDir, { recursive: true, force: true });
            } catch { /* best effort */ }
        }
    };
}

function sendMultipartRequest(handler, { files = [], contentTypeOverride = null } = {}) {
    const boundary = "----TestBoundary" + Math.random().toString(36).slice(2);
    const req = new PassThrough();
    req.headers = {
        "content-type": contentTypeOverride !== null
            ? contentTypeOverride
            : `multipart/form-data; boundary=${boundary}`
    };

    let statusCode = 200;
    const headers = {};
    let body = "";
    let ended = false;
    let finishPromiseResolve;
    const finishPromise = new Promise(resolve => { finishPromiseResolve = resolve; });

    const res = {
        get statusCode() { return statusCode; },
        set statusCode(val) { statusCode = val; },
        setHeader(k, v) { headers[k.toLowerCase()] = v; },
        getHeader(k) { return headers[k.toLowerCase()]; },
        status(code) { statusCode = code; return res; },
        json(data) {
            headers["content-type"] = "application/json";
            return res.end(JSON.stringify(data));
        },
        end(chunk) {
            if (ended) return;
            if (chunk) body += chunk.toString();
            ended = true;
            finishPromiseResolve({
                statusCode,
                headers,
                body,
                json: () => JSON.parse(body)
            });
        }
    };

    req.on("error", () => {});

    // Invoke handler
    handler(req, res);

    if (contentTypeOverride && !contentTypeOverride.toLowerCase().includes("multipart/form-data")) {
        // Did not send multipart, return immediately
        return finishPromise;
    }

    // Write multipart body
    for (const file of files) {
        if (ended) break;
        req.write(`--${boundary}\r\n`);
        req.write(`Content-Disposition: form-data; name="${file.fieldname || "files"}"; filename="${file.filename || "test.wav"}"\r\n`);
        req.write(`Content-Type: ${file.mime || "audio/wav"}\r\n\r\n`);
        req.write(file.content);
        req.write("\r\n");
    }
    if (!ended) {
        req.write(`--${boundary}--\r\n`);
        req.end();
    }

    return finishPromise;
}

test("1. sha256File computes accurate sha256 hash", async () => {
    const env = setupTestEnv();
    try {
        const filePath = path.join(env.tmpDir, "hash-test.bin");
        const content = Buffer.from("SelfBotMusik audio sample content for sha256 check");
        fs.writeFileSync(filePath, content);

        const expectedHash = crypto.createHash("sha256").update(content).digest("hex");
        const computedHash = await sha256File(filePath);

        assert.strictEqual(computedHash, expectedHash);

        // Same content -> same hash
        const computedHash2 = await sha256File(filePath);
        assert.strictEqual(computedHash2, expectedHash);
    } finally {
        env.cleanup();
    }
});

test("2. parseAudioFile fallback: file without tag extracts title from cleaned filename and artist Unknown", async () => {
    const env = setupTestEnv();
    try {
        const wavData = createWavBuffer({ durationSeconds: 2 });
        const filePath = path.join(env.tmpDir, "my-cool_test-track.wav");
        fs.writeFileSync(filePath, wavData);

        const meta = await parseAudioFile(filePath);
        assert.strictEqual(meta.title, "My Cool Test Track");
        assert.strictEqual(meta.artist, "Unknown");
        assert.strictEqual(meta.album, null);
        assert.strictEqual(meta.cover, null);
        assert.strictEqual(typeof meta.durationMs, "number");
        assert.strictEqual(meta.durationMs, 2000);
    } finally {
        env.cleanup();
    }
});

test("3. Handler rejects non-multipart request with 400", async () => {
    const env = setupTestEnv();
    try {
        const handler = createUploadHandler({
            library: env.fakeLibrary,
            db: env.fakeDb,
            dataDir: env.tmpDir
        });

        const res1 = await sendMultipartRequest(handler, { contentTypeOverride: "application/json" });
        assert.strictEqual(res1.statusCode, 400);
        assert.deepStrictEqual(res1.json(), { error: "Expected multipart/form-data" });

        const res2 = await sendMultipartRequest(handler, { contentTypeOverride: "" });
        assert.strictEqual(res2.statusCode, 400);
        assert.deepStrictEqual(res2.json(), { error: "Expected multipart/form-data" });
    } finally {
        env.cleanup();
    }
});

test("4. Handler rejects non-audio file with 400 and removes .tmp files", async () => {
    const env = setupTestEnv();
    try {
        const handler = createUploadHandler({
            library: env.fakeLibrary,
            db: env.fakeDb,
            dataDir: env.tmpDir
        });

        const tmpSubDir = path.join(env.libraryDir, ".tmp");

        const res = await sendMultipartRequest(handler, {
            files: [
                {
                    fieldname: "file",
                    filename: "corrupt.mp3",
                    mime: "audio/mpeg",
                    content: Buffer.from("Not a real audio file, just random text content")
                }
            ]
        });

        assert.strictEqual(res.statusCode, 400);
        assert.deepStrictEqual(res.json(), { error: "Unsupported or corrupt audio file" });

        // Verify .tmp folder has no lingering files
        if (fs.existsSync(tmpSubDir)) {
            const leftover = fs.readdirSync(tmpSubDir);
            assert.strictEqual(leftover.length, 0);
        }

        // Verify audit log has upload_failed
        const auditLog = env.db.prepare("SELECT * FROM audit_log WHERE event = 'upload_failed'").all();
        assert.strictEqual(auditLog.length > 0, true);
    } finally {
        env.cleanup();
    }
});

test("5. Dedup: uploading same file twice returns duplicate true on second upload and only 1 track in db", async () => {
    const env = setupTestEnv();
    try {
        const handler = createUploadHandler({
            library: env.fakeLibrary,
            db: env.fakeDb,
            dataDir: env.tmpDir
        });

        const wavData = createWavBuffer({ durationSeconds: 1 });
        const uploadFile = {
            fieldname: "file",
            filename: "dedup-song.wav",
            mime: "audio/wav",
            content: wavData
        };

        // First upload
        const res1 = await sendMultipartRequest(handler, { files: [uploadFile] });
        assert.strictEqual(res1.statusCode, 200);
        const data1 = res1.json();
        assert.strictEqual(data1.ok, true);
        assert.strictEqual(data1.tracks.length, 1);
        assert.strictEqual(data1.tracks[0].duplicate, false);
        assert.strictEqual(data1.tracks[0].downloaded, true);
        const trackId = data1.tracks[0].id;

        // Second upload with identical file
        const res2 = await sendMultipartRequest(handler, { files: [uploadFile] });
        assert.strictEqual(res2.statusCode, 200);
        const data2 = res2.json();
        assert.strictEqual(data2.ok, true);
        assert.strictEqual(data2.tracks.length, 1);
        assert.strictEqual(data2.tracks[0].id, trackId);
        assert.strictEqual(data2.tracks[0].duplicate, true);
        assert.strictEqual(data2.tracks[0].downloaded, true);

        // Verify only one track exists in database
        const rows = env.db.prepare("SELECT * FROM tracks").all();
        assert.strictEqual(rows.length, 1);

        // Verify .tmp folder is clean
        const tmpSubDir = path.join(env.libraryDir, ".tmp");
        if (fs.existsSync(tmpSubDir)) {
            assert.strictEqual(fs.readdirSync(tmpSubDir).length, 0);
        }
    } finally {
        env.cleanup();
    }
});

test("6. Upload success: saves cover in data/covers/<id>.<ext>, relative file_path, and sha256", async () => {
    const env = setupTestEnv();
    try {
        const fakeCoverBytes = Buffer.from("fake-png-image-binary-data");
        const stubParseFile = async () => ({
            format: { duration: 3.5, container: "WAVE" },
            common: {
                title: "Tagged Song Title",
                artist: "The Test Band",
                album: "Test Album",
                picture: [
                    { data: fakeCoverBytes, format: "image/png" }
                ]
            }
        });

        const handler = createUploadHandler({
            library: env.fakeLibrary,
            db: env.fakeDb,
            dataDir: env.tmpDir,
            parseFile: stubParseFile
        });

        const wavData = createWavBuffer({ durationSeconds: 3 });
        const expectedSha = crypto.createHash("sha256").update(wavData).digest("hex");

        const res = await sendMultipartRequest(handler, {
            files: [
                {
                    fieldname: "files",
                    filename: "tagged-song.wav",
                    mime: "audio/wav",
                    content: wavData
                }
            ]
        });

        assert.strictEqual(res.statusCode, 200);
        const data = res.json();
        assert.strictEqual(data.ok, true);
        assert.strictEqual(data.tracks.length, 1);

        const track = data.tracks[0];
        assert.strictEqual(track.title, "Tagged Song Title");
        assert.strictEqual(track.artist, "The Test Band");
        assert.strictEqual(track.album, "Test Album");
        assert.strictEqual(track.durationMs, 3500);
        assert.strictEqual(track.duplicate, false);
        assert.strictEqual(track.downloaded, true);

        // Check database row
        const row = env.db.prepare("SELECT * FROM tracks WHERE id = ?").get(track.id);
        assert.ok(row);
        assert.strictEqual(row.sha256, expectedSha);
        assert.strictEqual(row.source_key, `sha256:${expectedSha}`);
        assert.strictEqual(row.file_path, `${track.id}.wav`);
        assert.strictEqual(row.cover_path, `${track.id}.png`);
        assert.strictEqual(row.format, "wav");
        assert.strictEqual(row.file_size, wavData.length);
        assert.ok(row.downloaded_at);

        // Check physical files on disk
        const savedAudioPath = path.join(env.libraryDir, row.file_path);
        assert.strictEqual(fs.existsSync(savedAudioPath), true);
        assert.strictEqual(fs.readFileSync(savedAudioPath).length, wavData.length);

        const savedCoverPath = path.join(env.coversDir, row.cover_path);
        assert.strictEqual(fs.existsSync(savedCoverPath), true);
        assert.deepStrictEqual(fs.readFileSync(savedCoverPath), fakeCoverBytes);
    } finally {
        env.cleanup();
    }
});

test("7. Size limit: file exceeding max_upload_mb rejected with 400 and temp files removed", async () => {
    const env = setupTestEnv();
    try {
        const handler = createUploadHandler({
            library: env.fakeLibrary,
            db: env.fakeDb,
            dataDir: env.tmpDir,
            maxUploadMb: 1 // 1 MB limit
        });

        // Generate 1.2 MB buffer
        const largeBuffer = Buffer.alloc(1.2 * 1024 * 1024);

        const res = await sendMultipartRequest(handler, {
            files: [
                {
                    fieldname: "file",
                    filename: "oversized.wav",
                    mime: "audio/wav",
                    content: largeBuffer
                }
            ]
        });

        assert.strictEqual(res.statusCode, 400);
        assert.deepStrictEqual(res.json(), { error: "File exceeds maximum size" });

        // Verify .tmp cleaned
        const tmpSubDir = path.join(env.libraryDir, ".tmp");
        if (fs.existsSync(tmpSubDir)) {
            assert.strictEqual(fs.readdirSync(tmpSubDir).length, 0);
        }

        // Verify audit log
        const auditLog = env.db.prepare("SELECT * FROM audit_log WHERE event = 'upload_failed'").all();
        assert.strictEqual(auditLog.length > 0, true);
    } finally {
        env.cleanup();
    }
});

test("8. Quota limit: rejects upload with 400 when disk quota exceeded", async () => {
    const env = setupTestEnv();
    try {
        env.fakeDb.setSetting("library_quota_gb", "1"); // 1 GB quota
        // Set fake disk usage to 1 GB already
        env.fakeLibrary.diskUsageResult = {
            bytes: 1024 * 1024 * 1024,
            mb: 1024,
            gb: 1,
            count: 100
        };

        const handler = createUploadHandler({
            library: env.fakeLibrary,
            db: env.fakeDb,
            dataDir: env.tmpDir
        });

        const wavData = createWavBuffer({ durationSeconds: 1 });
        const res = await sendMultipartRequest(handler, {
            files: [
                {
                    fieldname: "file",
                    filename: "song.wav",
                    mime: "audio/wav",
                    content: wavData
                }
            ]
        });

        assert.strictEqual(res.statusCode, 400);
        assert.deepStrictEqual(res.json(), { error: "Library disk quota exceeded" });

        // Verify .tmp cleaned
        const tmpSubDir = path.join(env.libraryDir, ".tmp");
        if (fs.existsSync(tmpSubDir)) {
            assert.strictEqual(fs.readdirSync(tmpSubDir).length, 0);
        }

        // Verify audit log
        const auditLog = env.db.prepare("SELECT * FROM audit_log WHERE event = 'upload_failed'").all();
        assert.strictEqual(auditLog.length > 0, true);
    } finally {
        env.cleanup();
    }
});

test("9. File limit: more than 20 files rejected with 400", async () => {
    const env = setupTestEnv();
    try {
        const handler = createUploadHandler({
            library: env.fakeLibrary,
            db: env.fakeDb,
            dataDir: env.tmpDir
        });

        const wavData = createWavBuffer({ durationSeconds: 1 });
        const files = [];
        for (let i = 0; i < 21; i++) {
            files.push({
                fieldname: "files",
                filename: `song-${i}.wav`,
                mime: "audio/wav",
                content: wavData
            });
        }

        const res = await sendMultipartRequest(handler, { files });
        assert.strictEqual(res.statusCode, 400);

        // Verify audit log
        const auditLog = env.db.prepare("SELECT * FROM audit_log WHERE event = 'upload_failed'").all();
        assert.strictEqual(auditLog.length > 0, true);
    } finally {
        env.cleanup();
    }
});

test("10. Default handleUpload singleton is exported as a function", () => {
    assert.strictEqual(typeof handleUpload, "function");
});
