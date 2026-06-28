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
db.exec(`
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
`);

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
    DB_PATH,
    DATA_DIR,
    getSetting,
    setSetting,
    getAllSettings,
    ensureJwtSecret,
    audit,
};
