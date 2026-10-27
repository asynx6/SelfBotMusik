"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const busboy = require("busboy");
const { parseFile } = require("music-metadata");

const defaultLibrary = require("./library");
const defaultDatabase = require("./database");

function cleanFilenameToTitle(filename) {
    if (!filename || typeof filename !== "string") return "Unknown";
    const base = path.basename(filename, path.extname(filename));
    const cleaned = base.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) return "Unknown";
    return cleaned.replace(/\b\w/g, c => c.toUpperCase());
}

function getCoverExt(mime) {
    if (!mime || typeof mime !== "string") return "jpg";
    const m = mime.toLowerCase();
    if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
    if (m.includes("png")) return "png";
    if (m.includes("webp")) return "webp";
    if (m.includes("gif")) return "gif";
    return "jpg";
}

function resolveAudioFormat(filename, meta, library) {
    const ext = (path.extname(filename || "").slice(1) || "").toLowerCase().trim();
    const allowed = library?.ALLOWED_AUDIO_EXTENSIONS || new Set([
        "mp3", "m4a", "opus", "ogg", "wav", "flac", "webm", "aac", "oga"
    ]);
    if (allowed.has(ext)) return ext;
    const container = (meta?.format?.container || "").toLowerCase();
    if (container.includes("wave") || container.includes("wav")) return "wav";
    if (container.includes("flac")) return "flac";
    if (container.includes("ogg")) return "ogg";
    if (container.includes("mpeg") || container.includes("mp3")) return "mp3";
    if (container.includes("mp4") || container.includes("m4a")) return "m4a";
    return ext || "mp3";
}

function moveFile(src, dest) {
    try {
        fs.renameSync(src, dest);
    } catch (err) {
        if (err.code === "EXDEV") {
            fs.copyFileSync(src, dest);
            fs.unlinkSync(src);
        } else {
            throw err;
        }
    }
}

function sendJson(res, statusCode, body) {
    if (res.headersSent) return;
    if (typeof res.status === "function" && typeof res.json === "function") {
        res.status(statusCode).json(body);
    } else {
        res.statusCode = statusCode;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(body));
    }
}

async function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(filePath);
        stream.on("data", chunk => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", reject);
    });
}

async function parseAudioFile(filePath, options = {}) {
    let originalFilename = filePath;
    let parseFn = parseFile;

    if (typeof options === "string") {
        originalFilename = options;
    } else if (typeof options === "function") {
        parseFn = options;
    } else if (options && typeof options === "object") {
        if (options.filename) originalFilename = options.filename;
        if (options.parseFile) parseFn = options.parseFile;
    }

    const meta = await parseFn(filePath);

    if (!meta || !meta.format || (!meta.format.container && !meta.format.codec)) {
        throw new Error("Unsupported or corrupt audio file");
    }

    const title = (meta?.common?.title && String(meta.common.title).trim())
        ? String(meta.common.title).trim()
        : cleanFilenameToTitle(originalFilename);

    const artist = (meta?.common?.artist && String(meta.common.artist).trim())
        ? String(meta.common.artist).trim()
        : "Unknown";

    const album = (meta?.common?.album && String(meta.common.album).trim())
        ? String(meta.common.album).trim()
        : null;

    let durationMs = null;
    if (meta?.format && typeof meta.format.duration === "number" && !Number.isNaN(meta.format.duration)) {
        durationMs = Math.round(meta.format.duration * 1000);
    }

    let cover = null;
    const pic = meta?.common?.picture?.[0];
    if (pic && pic.data) {
        cover = {
            data: Buffer.isBuffer(pic.data) ? pic.data : Buffer.from(pic.data),
            mime: pic.format || pic.mime || "image/jpeg"
        };
    }

    return { title, artist, album, durationMs, cover };
}

function createUploadHandler(deps = {}) {
    const library = deps.library || defaultLibrary;
    const db = deps.db || defaultDatabase;
    const sqliteDb = db.prepare ? db : (db.db || db);
    const dataDir = deps.dataDir || db.DATA_DIR || defaultDatabase.DATA_DIR;
    const defaultParseFn = deps.parseFile || parseFile;

    const libraryDir = path.join(dataDir, "library");
    const tmpDir = path.join(libraryDir, ".tmp");
    const coversDir = path.join(dataDir, "covers");

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

    function audit(event, detail) {
        if (typeof db.audit === "function") {
            db.audit(event, detail);
        } else if (sqliteDb && typeof sqliteDb.prepare === "function") {
            try {
                sqliteDb.prepare("INSERT INTO audit_log (ts, event, detail) VALUES (?, ?, ?)").run(
                    Date.now(), event, detail ? String(detail).slice(0, 500) : null
                );
            } catch { /* best effort */ }
        }
    }

    // ponytail: in-memory sequential multipart batching; stream pipeline workers if massive concurrent multi-file uploads needed
    return function uploadHandler(req, res) {
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
        if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });

        const contentType = req.headers ? (req.headers["content-type"] || "") : "";
        if (!contentType.toLowerCase().includes("multipart/form-data")) {
            return sendJson(res, 400, { error: "Expected multipart/form-data" });
        }

        const maxMb = deps.maxUploadMb !== undefined
            ? Number(deps.maxUploadMb)
            : (parseInt(getSetting("max_upload_mb", "200"), 10) || 200);
        const maxFileBytes = maxMb * 1024 * 1024;

        let hasFailed = false;
        const tmpFilesToClean = new Set();
        const activeOutStreams = new Set();

        function cleanupTmp() {
            for (const outStream of activeOutStreams) {
                try { outStream.destroy(); } catch { /* best effort */ }
            }
            activeOutStreams.clear();
            for (const p of tmpFilesToClean) {
                try {
                    if (fs.existsSync(p)) fs.unlinkSync(p);
                } catch { /* best effort */ }
            }
            tmpFilesToClean.clear();
        }

        function fail(statusCode, message) {
            if (hasFailed) return;
            hasFailed = true;
            try { if (bb) bb.destroy(); } catch { /* ignore */ }
            cleanupTmp();
            audit("upload_failed", message);
            sendJson(res, statusCode, { error: message });
            try {
                req.unpipe();
                req.resume();
            } catch { /* ignore */ }
        }

        let bb;
        try {
            bb = busboy({ headers: req.headers, limits: { files: 20 } });
        } catch (err) {
            return fail(400, err.message || "Invalid multipart request");
        }

        let fileCount = 0;
        let filesLimitHit = false;
        const filePromises = [];

        bb.on("filesLimit", () => {
            filesLimitHit = true;
        });

        bb.on("file", (fieldname, fileStream, info) => {
            if (hasFailed) {
                fileStream.resume();
                return;
            }

            if (fieldname !== "file" && fieldname !== "files") {
                fileStream.resume();
                return;
            }

            fileCount++;
            if (fileCount > 20 || filesLimitHit) {
                filesLimitHit = true;
                fileStream.resume();
                return;
            }

            const filename = (info && typeof info === "object" ? info.filename : info) || "upload";
            const randomSuffix = crypto.randomBytes(8).toString("hex");
            const extFromFilename = (path.extname(filename).slice(1) || "").toLowerCase().trim();
            const tmpFileName = `upload-${randomSuffix}${extFromFilename ? ("." + extFromFilename) : ".tmp"}`;
            const tmpPath = path.join(tmpDir, tmpFileName);
            tmpFilesToClean.add(tmpPath);

            const outStream = fs.createWriteStream(tmpPath);
            activeOutStreams.add(outStream);
            const hash = crypto.createHash("sha256");
            let bytesWritten = 0;

            const writePromise = new Promise((resolve, reject) => {
                fileStream.on("data", chunk => {
                    if (hasFailed) return;
                    bytesWritten += chunk.length;
                    if (bytesWritten > maxFileBytes) {
                        fileStream.resume();
                        outStream.destroy(new Error("File exceeds maximum size"));
                        return;
                    }
                    hash.update(chunk);
                    if (!outStream.write(chunk)) {
                        fileStream.pause();
                    }
                });

                outStream.on("drain", () => {
                    fileStream.resume();
                });

                fileStream.on("end", () => {
                    outStream.end();
                });

                fileStream.on("error", err => {
                    activeOutStreams.delete(outStream);
                    reject(err);
                });
                outStream.on("error", err => {
                    activeOutStreams.delete(outStream);
                    reject(err);
                });
                outStream.on("finish", () => {
                    activeOutStreams.delete(outStream);
                    resolve({
                        tmpPath,
                        filename,
                        bytesWritten,
                        sha256: hash.digest("hex")
                    });
                });
            });

            filePromises.push(
                writePromise.catch(err => {
                    if (err && err.message === "File exceeds maximum size") {
                        fail(400, "File exceeds maximum size");
                    } else {
                        fail(400, err ? (err.message || "Upload stream error") : "Upload stream error");
                    }
                    throw err;
                })
            );
        });

        bb.on("error", err => {
            fail(400, err.message || "Upload parsing error");
        });

        req.on("error", err => {
            fail(400, err.message || "Upload request error");
        });

        bb.on("close", async () => {
            if (hasFailed) return;
            let fileResults;
            try {
                fileResults = await Promise.all(filePromises);
            } catch {
                return;
            }

            if (hasFailed) return;

            if (filesLimitHit || fileCount > 20) {
                fail(400, "Too many files (maximum 20)");
                return;
            }

            // Step 1: Pre-validation & dedup check
            const plan = [];
            let totalNewBytes = 0;

            for (const fileResult of fileResults) {
                if (hasFailed) return;
                const { tmpPath, filename, bytesWritten, sha256 } = fileResult;

                const existing = library.findBySha256(sha256);
                if (existing) {
                    plan.push({ isDuplicate: true, existing, tmpPath });
                    continue;
                }

                let meta;
                try {
                    meta = await parseAudioFile(tmpPath, { filename, parseFile: defaultParseFn });
                } catch {
                    fail(400, "Unsupported or corrupt audio file");
                    return;
                }

                totalNewBytes += bytesWritten;
                plan.push({
                    isDuplicate: false,
                    tmpPath,
                    filename,
                    bytesWritten,
                    sha256,
                    meta
                });
            }

            if (hasFailed) return;

            // Step 2: Quota check for new bytes
            if (totalNewBytes > 0) {
                const quotaGb = parseFloat(getSetting("library_quota_gb", "10")) || 10;
                const maxQuotaBytes = quotaGb * 1024 * 1024 * 1024;
                try {
                    const usage = await library.diskUsage();
                    if ((usage.bytes + totalNewBytes) > maxQuotaBytes) {
                        fail(400, "Library disk quota exceeded");
                        return;
                    }
                } catch {
                    fail(400, "Failed to check disk quota");
                    return;
                }
            }

            if (hasFailed) return;

            // Step 3: Commit tracks
            const processedTracks = [];

            for (const item of plan) {
                if (item.isDuplicate) {
                    try {
                        if (fs.existsSync(item.tmpPath)) fs.unlinkSync(item.tmpPath);
                    } catch { /* ignore */ }
                    tmpFilesToClean.delete(item.tmpPath);

                    processedTracks.push({
                        id: item.existing.id,
                        title: item.existing.title,
                        artist: item.existing.artist,
                        album: item.existing.album,
                        durationMs: item.existing.duration_ms,
                        duplicate: true,
                        downloaded: Boolean(item.existing.file_path)
                    });
                    continue;
                }

                const { tmpPath, filename, bytesWritten, sha256, meta } = item;
                const format = resolveAudioFormat(filename, meta, library);
                const now = Date.now();
                let trackId;

                try {
                    const insert = sqliteDb.prepare(`
                        INSERT INTO tracks (
                            source_key, source_type, source_name, identifier,
                            title, artist, album, duration_ms, uri,
                            file_size, format, sha256,
                            created_at, downloaded_at
                        ) VALUES (?, 'upload', 'upload', NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
                    `);
                    const info = insert.run(
                        `sha256:${sha256}`,
                        meta.title,
                        meta.artist,
                        meta.album,
                        meta.durationMs,
                        bytesWritten,
                        format,
                        sha256,
                        now,
                        now
                    );
                    trackId = info.lastInsertRowid;
                } catch (err) {
                    fail(400, `Database error: ${err.message}`);
                    return;
                }

                const finalFileName = `${trackId}.${format}`;
                const finalAudioPath = path.join(libraryDir, finalFileName);

                try {
                    moveFile(tmpPath, finalAudioPath);
                    tmpFilesToClean.delete(tmpPath);
                } catch (err) {
                    fail(400, `Failed to store file: ${err.message}`);
                    return;
                }

                let coverPath = null;
                if (meta.cover && meta.cover.data) {
                    try {
                        const coverExt = getCoverExt(meta.cover.mime);
                        coverPath = `${trackId}.${coverExt}`;
                        const finalCoverPath = path.join(coversDir, coverPath);
                        fs.writeFileSync(finalCoverPath, meta.cover.data);
                    } catch {
                        coverPath = null;
                    }
                }

                try {
                    sqliteDb.prepare(`
                        UPDATE tracks
                        SET file_path = ?, cover_path = ?
                        WHERE id = ?
                    `).run(finalFileName, coverPath, trackId);
                } catch (err) {
                    fail(400, `Database update error: ${err.message}`);
                    return;
                }

                processedTracks.push({
                    id: trackId,
                    title: meta.title,
                    artist: meta.artist,
                    album: meta.album,
                    durationMs: meta.durationMs,
                    duplicate: false,
                    downloaded: true
                });
            }

            if (hasFailed) return;
            sendJson(res, 200, { ok: true, tracks: processedTracks });
        });

        req.pipe(bb);
    };
}

const handleUpload = createUploadHandler();

module.exports = {
    createUploadHandler,
    handleUpload,
    parseAudioFile,
    sha256File,
};
