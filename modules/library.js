"use strict";

const fs = require("fs");
const path = require("path");
const { db, DATA_DIR } = require("./database");

const FILE_NAME_REGEX = /^\d+\.[A-Za-z0-9]{1,8}$/;

const ALLOWED_AUDIO_EXTENSIONS = new Set([
    "mp3", "m4a", "opus", "ogg", "wav", "flac", "webm", "aac", "oga"
]);

const ALLOWED_COVER_EXTENSIONS = new Set([
    "jpg", "jpeg", "png", "webp", "gif"
]);

function getLibraryDir() {
    const dir = path.join(DATA_DIR, "library");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getCoversDir() {
    const dir = path.join(DATA_DIR, "covers");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// Ensure folders exist on boot
getLibraryDir();
getCoversDir();

function resolveFilePath(filePath) {
    if (!filePath || typeof filePath !== "string" || !FILE_NAME_REGEX.test(filePath)) {
        throw new Error(`Invalid file path / path traversal detected: ${filePath}`);
    }
    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (!ALLOWED_AUDIO_EXTENSIONS.has(ext)) {
        throw new Error(`Disallowed audio extension: ${ext}`);
    }
    return path.join(getLibraryDir(), filePath);
}

function resolveCoverPath(coverPath) {
    if (!coverPath || typeof coverPath !== "string" || !FILE_NAME_REGEX.test(coverPath)) {
        throw new Error(`Invalid cover path / path traversal detected: ${coverPath}`);
    }
    const ext = path.extname(coverPath).slice(1).toLowerCase();
    if (!ALLOWED_COVER_EXTENSIONS.has(ext)) {
        throw new Error(`Disallowed cover extension: ${ext}`);
    }
    return path.join(getCoversDir(), coverPath);
}

function getById(id) {
    if (id === null || id === undefined) return null;
    const row = db.prepare("SELECT * FROM tracks WHERE id = ?").get(id);
    return row ?? null;
}

function findBySourceKey(sourceKey) {
    if (!sourceKey) return null;
    const row = db.prepare("SELECT * FROM tracks WHERE source_key = ?").get(sourceKey);
    return row ?? null;
}

function findBySha256(sha256) {
    if (!sha256) return null;
    const row = db.prepare("SELECT * FROM tracks WHERE sha256 = ?").get(sha256);
    return row ?? null;
}

function upsertFromLavalink(info) {
    if (!info || !info.sourceName || !info.identifier) {
        throw new Error("Invalid lavalink track info: sourceName and identifier required");
    }
    const sourceKey = `${info.sourceName}:${info.identifier}`;
    const existing = findBySourceKey(sourceKey);
    if (existing) return existing;

    const title = info.title || "Unknown";
    const artist = info.author || null;
    const album = info.album || null;
    const durationMs = info.length ?? null;
    const uri = info.uri || null;
    const coverUrl = info.artworkUrl || null;
    const createdAt = Date.now();

    const insert = db.prepare(`
        INSERT OR IGNORE INTO tracks (
            source_key, source_type, source_name, identifier,
            title, artist, album, duration_ms, uri, cover_url, created_at
        ) VALUES (?, 'lavalink', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const res = insert.run(
        sourceKey,
        info.sourceName,
        info.identifier,
        title,
        artist,
        album,
        durationMs,
        uri,
        coverUrl,
        createdAt
    );

    if (res.changes === 0) {
        return findBySourceKey(sourceKey);
    }
    return getById(res.lastInsertRowid);
}

function list({ query, filter = "all", limit = 50, offset = 0 } = {}) {
    const conditions = [];
    const params = [];

    if (filter === "local") {
        conditions.push("file_path IS NOT NULL");
    } else if (filter === "reference") {
        conditions.push("file_path IS NULL");
    }

    if (query && typeof query === "string" && query.trim().length > 0) {
        const pattern = `%${query.trim()}%`;
        conditions.push("(title LIKE ? OR artist LIKE ? OR album LIKE ?)");
        params.push(pattern, pattern, pattern);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countSql = `SELECT COUNT(*) AS total FROM tracks ${whereClause}`;
    const total = db.prepare(countSql).get(...params).total;

    const lim = Number.isInteger(Number(limit)) && Number(limit) >= 0 ? Number(limit) : 50;
    const off = Number.isInteger(Number(offset)) && Number(offset) >= 0 ? Number(offset) : 0;

    const listSql = `SELECT * FROM tracks ${whereClause} ORDER BY id ASC LIMIT ? OFFSET ?`;
    const tracks = db.prepare(listSql).all(...params, lim, off);

    return { tracks, total };
}

function attachFile(id, { filePath, fileSize, format, sha256 } = {}) {
    if (!filePath || !FILE_NAME_REGEX.test(filePath)) {
        throw new Error(`Invalid file path: ${filePath}`);
    }
    const ext = (format || path.extname(filePath).slice(1) || "").toLowerCase().replace(/^\./, "");
    if (!ALLOWED_AUDIO_EXTENSIONS.has(ext)) {
        throw new Error(`Disallowed audio format: ${ext}`);
    }
    const downloadedAt = Date.now();
    db.prepare(`
        UPDATE tracks
        SET file_path = ?, file_size = ?, format = ?, sha256 = ?, downloaded_at = ?
        WHERE id = ?
    `).run(filePath, fileSize ?? null, ext, sha256 ?? null, downloadedAt, id);

    return getById(id);
}

function removeFile(id) {
    const track = getById(id);
    if (!track) return null;

    if (track.file_path) {
        try {
            const absPath = resolveFilePath(track.file_path);
            if (fs.existsSync(absPath)) {
                fs.unlinkSync(absPath);
            }
        } catch {
            // Ignore missing or unresolvable file, continue resetting columns
        }
    }

    db.prepare(`
        UPDATE tracks
        SET file_path = NULL, file_size = NULL, format = NULL, sha256 = NULL, downloaded_at = NULL
        WHERE id = ?
    `).run(id);

    return getById(id);
}

function remove(id) {
    const track = getById(id);
    if (track) {
        if (track.file_path) {
            try {
                const absPath = resolveFilePath(track.file_path);
                if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
            } catch { /* best effort */ }
        }
        if (track.cover_path) {
            try {
                const absCover = resolveCoverPath(track.cover_path);
                if (fs.existsSync(absCover)) fs.unlinkSync(absCover);
            } catch { /* best effort */ }
        }
        db.prepare("DELETE FROM tracks WHERE id = ?").run(id);
    }
    return { deleted: true };
}

function diskUsage() {
    const dir = getLibraryDir();
    let bytes = 0;
    let count = 0;
    if (fs.existsSync(dir)) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isFile()) {
                try {
                    const st = fs.statSync(path.join(dir, entry.name));
                    bytes += st.size;
                    count++;
                } catch { /* file removed during scan */ }
            }
        }
    }
    const mb = Number((bytes / (1024 * 1024)).toFixed(2));
    const gb = Number((bytes / (1024 * 1024 * 1024)).toFixed(2));
    const result = { bytes, mb, gb, count };
    const promise = Promise.resolve(result);
    Object.assign(promise, result);
    return promise;
}

module.exports = {
    upsertFromLavalink,
    getById,
    list,
    attachFile,
    removeFile,
    remove,
    findBySourceKey,
    findBySha256,
    diskUsage,
    resolveFilePath,
    resolveCoverPath,
    getLibraryDir,
    getCoversDir,
    ALLOWED_AUDIO_EXTENSIONS,
    ALLOWED_COVER_EXTENSIONS,
    FILE_NAME_REGEX,
};
