"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { pipeline } = require("node:stream/promises");
const childProcess = require("node:child_process");

const defaultLibrary = require("./library");
const defaultDatabase = require("./database");

const PROGRESS_REGEX = /\[download\]\s+(\d+(?:\.\d+)?)%/;

function createDownloadManager({
    spawn = childProcess.spawn,
    library = defaultLibrary,
    db = defaultDatabase,
    dataDir = defaultDatabase.DATA_DIR,
} = {}) {
    const emitter = new EventEmitter();

    // Support better-sqlite3 raw instance or wrapper object with .db / .prepare
    const sqliteDb = db.prepare ? db : (db.db || db);

    function getSetting(key, fallback = null) {
        if (typeof db.getSetting === "function") {
            return db.getSetting(key, fallback);
        }
        try {
            const row = sqliteDb.prepare("SELECT value FROM settings WHERE key = ?").get(key);
            return row ? (row.value ?? fallback) : fallback;
        } catch {
            return fallback;
        }
    }

    const libraryDir = path.join(dataDir, "library");
    const tmpDir = path.join(libraryDir, ".tmp");

    // In-memory active tasks: downloadId -> { id, trackId, proc, canceled, attempt, lastProgressWrite }
    const activeTasks = new Map();
    let isQueueRunning = false;

    function ensureDirs() {
        if (!fs.existsSync(libraryDir)) fs.mkdirSync(libraryDir, { recursive: true });
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    }

    function emitChange() {
        try {
            emitter.emit("change", { downloads: list() });
        } catch { /* listener error protection */ }
    }

    function getById(downloadId) {
        if (downloadId === null || downloadId === undefined) return null;
        const row = sqliteDb.prepare("SELECT * FROM downloads WHERE id = ?").get(downloadId);
        return row ?? null;
    }

    function list() {
        return sqliteDb.prepare("SELECT * FROM downloads ORDER BY id DESC").all();
    }

    function activeForTrack(trackId) {
        if (trackId === null || trackId === undefined) return null;
        const row = sqliteDb.prepare(`
            SELECT * FROM downloads
            WHERE track_id = ? AND status IN ('queued', 'running')
            ORDER BY id DESC LIMIT 1
        `).get(trackId);
        return row ?? null;
    }

    function isDownloading(trackId) {
        return Boolean(activeForTrack(trackId));
    }

    function checkFileOnDisk(track) {
        if (!track || !track.file_path) return false;
        const directPath = path.join(libraryDir, track.file_path);
        if (fs.existsSync(directPath)) return true;
        if (typeof library.resolveFilePath === "function") {
            try {
                if (fs.existsSync(library.resolveFilePath(track.file_path))) return true;
            } catch { /* invalid path or missing */ }
        }
        return false;
    }

    function cleanTmpFiles(downloadId) {
        if (!fs.existsSync(tmpDir)) return;
        try {
            const entries = fs.readdirSync(tmpDir);
            for (const file of entries) {
                if (file.startsWith(`${downloadId}.`)) {
                    try {
                        fs.unlinkSync(path.join(tmpDir, file));
                    } catch { /* best effort */ }
                }
            }
        } catch { /* best effort */ }
    }

    function findTmpFile(downloadId) {
        if (!fs.existsSync(tmpDir)) return null;
        const entries = fs.readdirSync(tmpDir);
        for (const file of entries) {
            if (file.startsWith(`${downloadId}.`) && !file.endsWith(".part") && !file.endsWith(".ytdl")) {
                return path.join(tmpDir, file);
            }
        }
        return null;
    }

    async function computeSha256(filePath) {
        const hash = crypto.createHash("sha256");
        await pipeline(fs.createReadStream(filePath), hash);
        return hash.digest("hex");
    }

    function enqueue(trackIds) {
        ensureDirs();
        const ids = Array.isArray(trackIds) ? trackIds : [trackIds];
        const results = [];
        const now = Date.now();

        for (const trackId of ids) {
            const track = library.getById(trackId);
            if (!track) {
                throw new Error(`Track not found: ${trackId}`);
            }

            // 1. If track already has file on disk -> done immediately
            if (checkFileOnDisk(track)) {
                const existing = sqliteDb.prepare(`
                    SELECT * FROM downloads WHERE track_id = ? ORDER BY id DESC LIMIT 1
                `).get(trackId);

                if (existing) {
                    sqliteDb.prepare(`
                        UPDATE downloads
                        SET status = 'done', progress = 1, finished_at = COALESCE(finished_at, ?)
                        WHERE id = ?
                    `).run(now, existing.id);
                    results.push(getById(existing.id));
                } else {
                    const ins = sqliteDb.prepare(`
                        INSERT INTO downloads (track_id, status, progress, created_at, started_at, finished_at)
                        VALUES (?, 'done', 1, ?, ?, ?)
                    `).run(trackId, now, now, now);
                    results.push(getById(ins.lastInsertRowid));
                }
                continue;
            }

            // 2. Reuse active download if one is already queued or running
            const active = activeForTrack(trackId);
            if (active) {
                results.push(active);
                continue;
            }

            // 3. Insert new queued task
            const ins = sqliteDb.prepare(`
                INSERT INTO downloads (track_id, status, progress, created_at)
                VALUES (?, 'queued', 0, ?)
            `).run(trackId, now);
            results.push(getById(ins.lastInsertRowid));
        }

        emitChange();
        setImmediate(processQueue);
        return results;
    }

    function cancel(downloadId) {
        const row = getById(downloadId);
        if (!row) {
            throw new Error(`Download not found: ${downloadId}`);
        }

        if (row.status === "done" || row.status === "failed" || row.status === "canceled") {
            throw new Error(`Cannot cancel download with status: ${row.status}`);
        }

        const now = Date.now();
        if (row.status === "queued") {
            sqliteDb.prepare(`
                UPDATE downloads SET status = 'canceled', finished_at = ? WHERE id = ?
            `).run(now, downloadId);
            cleanTmpFiles(downloadId);
            emitChange();
            return { ok: true };
        }

        // status === "running"
        const task = activeTasks.get(downloadId);
        if (task) {
            task.canceled = true;
            if (task.proc && typeof task.proc.kill === "function") {
                task.proc.kill("SIGTERM");
            }
            activeTasks.delete(downloadId);
        }

        sqliteDb.prepare(`
            UPDATE downloads SET status = 'canceled', finished_at = ? WHERE id = ?
        `).run(now, downloadId);
        cleanTmpFiles(downloadId);

        emitChange();
        setImmediate(processQueue);
        return { ok: true };
    }

    async function processQueue() {
        if (isQueueRunning) return;
        isQueueRunning = true;

        try {
            ensureDirs();
            const concurrencyLimit = parseInt(getSetting("download_concurrency", "3"), 10) || 3;

            while (activeTasks.size < concurrencyLimit) {
                const queuedRow = sqliteDb.prepare(`
                    SELECT * FROM downloads
                    WHERE status = 'queued'
                    ORDER BY id ASC LIMIT 1
                `).get();

                if (!queuedRow) break;

                const track = library.getById(queuedRow.track_id);
                if (!track || !track.uri) {
                    sqliteDb.prepare(`
                        UPDATE downloads
                        SET status = 'failed', error = ?, finished_at = ?
                        WHERE id = ?
                    `).run("Track or URI not found", Date.now(), queuedRow.id);
                    emitChange();
                    continue;
                }

                // Check quota before spawning
                let diskUsage = null;
                try {
                    diskUsage = await library.diskUsage();
                } catch {
                    diskUsage = { bytes: 0 };
                }

                // Check if canceled or modified while awaiting diskUsage
                const current = getById(queuedRow.id);
                if (!current || current.status !== "queued") continue;

                const quotaGb = parseFloat(getSetting("library_quota_gb", "10")) || 10;
                const quotaBytes = quotaGb * 1024 * 1024 * 1024;

                if (diskUsage && diskUsage.bytes >= quotaBytes) {
                    sqliteDb.prepare(`
                        UPDATE downloads
                        SET status = 'failed', error = ?, finished_at = ?
                        WHERE id = ?
                    `).run("Kapasitas penyimpanan melebihi kuota (quota exceeded)", Date.now(), queuedRow.id);
                    emitChange();
                    continue;
                }

                // Reserve task in activeTasks
                const task = {
                    id: queuedRow.id,
                    trackId: queuedRow.track_id,
                    uri: track.uri,
                    proc: null,
                    canceled: false,
                    attempt: 0,
                    lastProgressWrite: 0,
                };
                activeTasks.set(queuedRow.id, task);

                sqliteDb.prepare(`
                    UPDATE downloads
                    SET status = 'running', started_at = ?
                    WHERE id = ?
                `).run(Date.now(), queuedRow.id);
                emitChange();

                startSpawn(task);
            }
        } finally {
            isQueueRunning = false;
        }
    }

    function startSpawn(task) {
        if (task.canceled) return;

        const ytdlpPath = getSetting("ytdlp_path", "yt-dlp");
        const outTemplate = path.join(tmpDir, `${task.id}.%(ext)s`);
        const args = ["-f", "bestaudio/best", "--no-playlist", "--no-part", "-o", outTemplate, task.uri];

        let failureHandled = false;

        let child;
        try {
            child = spawn(ytdlpPath, args, { shell: false });
        } catch (err) {
            handleSpawnFailure(task, err.message || "Failed to spawn yt-dlp");
            return;
        }

        task.proc = child;
        let stderrBuffer = "";

        if (child.stdout) {
            child.stdout.on("data", (chunk) => {
                if (task.canceled) return;
                const match = PROGRESS_REGEX.exec(chunk.toString());
                if (match) {
                    const pct = parseFloat(match[1]);
                    const progress = Math.min(1, Math.max(0, pct / 100));
                    const now = Date.now();
                    // Throttle DB write: at most once every ~500ms
                    if (now - task.lastProgressWrite >= 500) {
                        task.lastProgressWrite = now;
                        sqliteDb.prepare("UPDATE downloads SET progress = ? WHERE id = ?").run(progress, task.id);
                        emitChange();
                    }
                }
            });
        }

        if (child.stderr) {
            child.stderr.on("data", (chunk) => {
                if (task.canceled) return;
                stderrBuffer += chunk.toString();
                // Also check progress regex on stderr if yt-dlp outputs there
                const match = PROGRESS_REGEX.exec(chunk.toString());
                if (match) {
                    const pct = parseFloat(match[1]);
                    const progress = Math.min(1, Math.max(0, pct / 100));
                    const now = Date.now();
                    if (now - task.lastProgressWrite >= 500) {
                        task.lastProgressWrite = now;
                        sqliteDb.prepare("UPDATE downloads SET progress = ? WHERE id = ?").run(progress, task.id);
                        emitChange();
                    }
                }
            });
        }

        child.on("error", (err) => {
            if (task.canceled || failureHandled) return;
            failureHandled = true;
            handleSpawnFailure(task, err.message || "yt-dlp child error");
        });

        child.on("close", (code, signal) => {
            if (task.canceled || failureHandled) return;
            failureHandled = true;
            if (code === 0) {
                handleSpawnSuccess(task);
            } else {
                const msg = stderrBuffer.trim() || (signal ? `Killed with ${signal}` : `yt-dlp exit code ${code}`);
                handleSpawnFailure(task, msg);
            }
        });
    }

    async function handleSpawnSuccess(task) {
        try {
            const tmpFile = findTmpFile(task.id);
            if (!tmpFile || !fs.existsSync(tmpFile)) {
                throw new Error("Downloaded output file not found in temporary directory");
            }

            const ext = path.extname(tmpFile).slice(1).toLowerCase();
            const targetFileName = `${task.trackId}.${ext}`;
            const targetPath = path.join(libraryDir, targetFileName);

            // Compute sha256 streaming
            const sha256 = await computeSha256(tmpFile);
            const fileSize = fs.statSync(tmpFile).size;

            // Move file to final location
            try {
                fs.renameSync(tmpFile, targetPath);
            } catch {
                fs.copyFileSync(tmpFile, targetPath);
                fs.unlinkSync(tmpFile);
            }

            // Attach file to track in library
            library.attachFile(task.trackId, {
                filePath: targetFileName,
                fileSize,
                format: ext,
                sha256,
            });

            // Update download row
            sqliteDb.prepare(`
                UPDATE downloads
                SET status = 'done', progress = 1, finished_at = ?
                WHERE id = ?
            `).run(Date.now(), task.id);

            cleanTmpFiles(task.id);
        } catch (err) {
            sqliteDb.prepare(`
                UPDATE downloads
                SET status = 'failed', error = ?, finished_at = ?
                WHERE id = ?
            `).run(String(err.message || err).slice(0, 300), Date.now(), task.id);
            cleanTmpFiles(task.id);
        } finally {
            activeTasks.delete(task.id);
            emitChange();
            setImmediate(processQueue);
        }
    }

    function handleSpawnFailure(task, errorMsg) {
        cleanTmpFiles(task.id);

        // Retry once if attempt === 0
        if (task.attempt === 0) {
            task.attempt = 1;
            task.lastProgressWrite = 0;
            // ponytail: immediate single retry; exponential backoff if flaky connections become an issue
            setImmediate(() => {
                if (!task.canceled) {
                    startSpawn(task);
                }
            });
            return;
        }

        // Exhausted retries -> fail
        activeTasks.delete(task.id);
        const truncatedError = String(errorMsg || "Download failed").slice(0, 300);
        sqliteDb.prepare(`
            UPDATE downloads
            SET status = 'failed', error = ?, finished_at = ?
            WHERE id = ?
        `).run(truncatedError, Date.now(), task.id);

        emitChange();
        setImmediate(processQueue);
    }

    const manager = Object.assign(emitter, {
        enqueue,
        list,
        getById,
        cancel,
        activeForTrack,
        isDownloading,
        createDownloadManager,
    });

    return manager;
}

const defaultManager = createDownloadManager();
defaultManager.createDownloadManager = createDownloadManager;

module.exports = defaultManager;
