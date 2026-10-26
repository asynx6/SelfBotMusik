"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "app.sqlite");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Boot-time schema. All persistent state lives here.
const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
    );
    CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY,
        username      TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        last_login    INTEGER
    );
    CREATE TABLE IF NOT EXISTS login_attempts (
        id      INTEGER PRIMARY KEY,
        ip      TEXT NOT NULL,
        ts      INTEGER NOT NULL,
        success INTEGER NOT NULL
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
    CREATE INDEX IF NOT EXISTS idx_tracks_sha256 ON tracks(sha256);
    CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
    CREATE TABLE IF NOT EXISTS playlists (
        id          INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS playlist_tracks (
        playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        track_id    INTEGER NOT NULL REFERENCES tracks(id)    ON DELETE CASCADE,
        position    INTEGER NOT NULL,
        added_at    INTEGER NOT NULL,
        PRIMARY KEY (playlist_id, track_id)
    );
    CREATE TABLE IF NOT EXISTS likes (
        track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
        liked_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history (
        id        INTEGER PRIMARY KEY,
        track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        played_at INTEGER NOT NULL,
        ms_played INTEGER
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
`;
db.exec(SCHEMA_SQL);

// ---- Default settings for the library/foundation phase. ----
// Only sets keys that don't yet exist so user values are never overwritten.
const DEFAULT_SETTINGS = {
    download_concurrency: "3",
    max_upload_mb: "200",
    library_quota_gb: "10",
    ytdlp_path: "yt-dlp",
    ffmpeg_path: "ffmpeg",
};

function ensureDefaults(targetDb = db) {
    const insert = targetDb.prepare(
        "INSERT INTO settings (key, value) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = ?)"
    );
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        insert.run(key, value, key);
    }
}
ensureDefaults();

// ---- Settings helpers (single-row key-value store). ----
function getSetting(key, fallback = null) {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    if (!row) return fallback;
    return row.value ?? fallback;
}

function setSetting(key, value) {
    if (value === null || value === undefined) return;
    const v = String(value);
    db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, v);
}

function getAllSettings() {
    const rows = db.prepare("SELECT key, value FROM settings").all();
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
}

// ---- Auto-generate JWT secret on first boot. ----
function ensureJwtSecret() {
    let s = getSetting("jwt_secret");
    if (!s) {
        s = crypto.randomBytes(48).toString("base64url");
        setSetting("jwt_secret", s);
    }
    return s;
}

// ---- Audit log helper. ----
function audit(event, detail = null) {
    try {
        db.prepare("INSERT INTO audit_log (ts, event, detail) VALUES (?, ?, ?)").run(
            Date.now(), event, detail ? String(detail).slice(0, 500) : null
        );
    } catch { /* best-effort */ }
}

module.exports = {
    db,
    SCHEMA_SQL,
    DB_PATH,
    DATA_DIR,
    getSetting,
    setSetting,
    getAllSettings,
    ensureDefaults,
    DEFAULT_SETTINGS,
    ensureJwtSecret,
    audit,
};
