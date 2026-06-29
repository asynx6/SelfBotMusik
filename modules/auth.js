"use strict";

const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const db = require("./database");

const JWT_SECRET = db.ensureJwtSecret(); // auto-generate on first import
const SESSION_COOKIE = "auth_token";
const SESSION_TTL = 30 * 24 * 60 * 60;   // 30 days
const LOGIN_WINDOW_MS = 15 * 60 * 1000;  // 15 min sliding window
const LOGIN_MAX_TRIES = 10;

// ---- User management ----
function seedDefaultUser() {
    // Default credentials: admin/changeme (UI prompts to change on first run).
    let row = db.db.prepare("SELECT id FROM users WHERE username = ?").get("admin");
    if (!row) {
        const hash = bcrypt.hashSync("changeme", 10);
        db.db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)")
            .run("admin", hash, Date.now());
        db.audit("user_seeded", "default admin user created (password=changeme)");
        return "admin";
    }
    return null;
}

function findUser(username) {
    return db.db.prepare("SELECT id, username, password_hash FROM users WHERE username = ?")
        .get(username);
}

function verifyPassword(username, plain) {
    const u = findUser(username);
    if (!u) return false;
    try { return bcrypt.compareSync(String(plain || ""), u.password_hash); }
    catch { return false; }
}

function setPassword(username, plain) {
    const hash = bcrypt.hashSync(String(plain), 10);
    const info = db.db.prepare("UPDATE users SET password_hash = ? WHERE username = ?")
        .run(hash, username);
    return info.changes > 0;
}

// ---- Login rate limiting ----
function recordLoginAttempt(ip, ok) {
    db.db.prepare("INSERT INTO login_attempts (ip, ts, success) VALUES (?, ?, ?)")
        .run(String(ip || "?"), Date.now(), ok ? 1 : 0);
}

function attemptsAllowed(ip) {
    const since = Date.now() - LOGIN_WINDOW_MS;
    const row = db.db.prepare(
        "SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ? AND ts >= ? AND success = 0"
    ).get(String(ip || "?"), since);
    return (row?.c || 0) < LOGIN_MAX_TRIES;
}

function pruneAttempts() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    db.db.prepare("DELETE FROM login_attempts WHERE ts < ?").run(cutoff);
}

// Periodic prune. Old attempts bloat DB and slow down attemptsAllowed().
setInterval(pruneAttempts, 60 * 60 * 1000).unref();

// ---- Token issue/verify ----
function issueToken(res) {
    const token = jwt.sign({ sub: "admin", role: "admin", ts: Date.now() }, JWT_SECRET, {
        expiresIn: SESSION_TTL,
    });
    res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "strict",
        secure: false, // set true behind HTTPS proxy
        maxAge: SESSION_TTL * 1000,
        path: "/",
    });
    return token;
}

function verifyToken(req) {
    const tok = req.cookies?.[SESSION_COOKIE];
    if (!tok) return false;
    try {
        const payload = jwt.verify(tok, JWT_SECRET);
        return payload?.sub === "admin";
    } catch { return false; }
}

module.exports = {
    SESSION_COOKIE,
    SESSION_TTL,
    seedDefaultUser,
    verifyPassword,
    setPassword,
    recordLoginAttempt,
    attemptsAllowed,
    pruneAttempts,
    issueToken,
    verifyToken,
};
