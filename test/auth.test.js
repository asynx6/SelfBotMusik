"use strict";

/**
 * Authentication contract: the dashboard must never be reachable without a
 * valid JWT cookie, and /api/auth/login must issue one.
 *
 * These paths were previously untested — only a single "API returns 401"
 * assertion existed — so a regression in the gate could go unnoticed.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Database = require("better-sqlite3");

// ---- Stub the database module before anything else requires it. ----
const dbModulePath = require.resolve("../modules/database");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbm-auth-"));
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
        setSetting: (key, value) => {
            testDb.prepare(
                "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
            ).run(key, String(value));
        },
        getAllSettings: () => {
            const out = {};
            for (const row of testDb.prepare("SELECT key, value FROM settings").all()) out[row.key] = row.value;
            return out;
        },
        audit: () => {},
        ensureJwtSecret: () => {
            let secret = testDb.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get()?.value;
            if (!secret) {
                secret = require("node:crypto").randomBytes(48).toString("base64url");
                testDb.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('jwt_secret', ?)").run(secret);
            }
            return secret;
        },
    },
};

const jwt = require("jsonwebtoken");
const auth = require("../modules/auth");
const { buildServer } = require("../modules/webserver");
const { PlayerController } = require("../modules/player-controller");
const { BaseEngine } = require("../modules/engines/base");

auth.seedDefaultUser(); // admin / changeme, exactly like a fresh install

class MockEngine extends BaseEngine {
    constructor() { super(); this.name = "mock"; }
    async play() {}
    async pause() {}
    async resume() {}
    async stop() {}
    async setVolume() {}
    getPositionMs() { return 0; }
    async destroy() {}
}

const controller = new PlayerController({
    dataDir: tmpDir,
    createLocalEngine: () => new MockEngine(),
    createLavalinkEngine: () => { throw new Error("lavalink unavailable in test"); },
    isLavalinkReady: () => false,
    db: testDb,
});

const { server } = buildServer({
    playerController: controller,
    searchTracks: async () => [],
    RuntimeSnapshot: () => ({}),
    syncStateFromPlayer: () => {},
    getPlayer: () => null,
    wss: null,
});
server.listen(0, "127.0.0.1");

const base = () => `http://127.0.0.1:${server.address().port}`;

function setCookies(res) {
    if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
    const raw = res.headers.get("set-cookie");
    return raw ? [raw] : [];
}

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test("gate: GET / without a cookie redirects to /login", async () => {
    const res = await fetch(base() + "/", { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/login");
});

test("gate: GET /login serves the password form", async () => {
    const res = await fetch(base() + "/login");
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /login-form/, "login form must be present");
    assert.match(html, /SelfBotMusic/, "login page carries the product name");
});

test("gate: GET /index.html cannot bypass the login redirect", async () => {
    const anonymous = await fetch(base() + "/index.html", { redirect: "manual" });
    assert.equal(anonymous.status, 302, "the shell must not be served off disk to anonymous users");
    assert.equal(anonymous.headers.get("location"), "/login");

    const secret = testDb.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get().value;
    const token = jwt.sign({ sub: "admin", role: "admin", ts: Date.now() }, secret, { expiresIn: 3600 });
    const authed = await fetch(base() + "/index.html", { headers: { cookie: `auth_token=${token}` } });
    assert.equal(authed.status, 200, "authenticated users still get the shell");
});

test("gate: GET / serves the dashboard when a valid JWT is presented", async () => {
    const secret = testDb.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get().value;
    const token = jwt.sign({ sub: "admin", role: "admin", ts: Date.now() }, secret, { expiresIn: 3600 });

    const res = await fetch(base() + "/", { headers: { cookie: `auth_token=${token}` } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<div id="root">/, "dashboard shell must be served");
});

test("login: wrong password is rejected and does not set a cookie", async () => {
    const res = await fetch(base() + "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "definitely-wrong" }),
    });
    assert.equal(res.status, 401);
    assert.equal(setCookies(res).length, 0, "no session cookie on failure");
});

test("login: correct password issues an HttpOnly JWT cookie", async () => {
    const res = await fetch(base() + "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "changeme" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    const cookies = setCookies(res);
    assert.equal(cookies.length, 1, "exactly one cookie is set");
    const cookie = cookies[0];
    assert.match(cookie, /^auth_token=/);
    assert.match(cookie, /HttpOnly/i, "cookie must not be readable from JS");
    assert.match(cookie, /SameSite=Strict/i, "cookie must not be sent cross-site");
    assert.match(cookie, /Path=\//);

    // The issued token must actually verify against the server secret.
    const token = cookie.split(";")[0].slice("auth_token=".length);
    const payload = jwt.verify(token, testDb.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get().value);
    assert.equal(payload.sub, "admin");

    // Session lifetime contract: 2 days, enforced in both the JWT and the cookie.
    assert.equal(auth.SESSION_TTL, 2 * 24 * 60 * 60, "session TTL must be 2 days");
    assert.equal(payload.exp - payload.iat, auth.SESSION_TTL, "JWT exp must match the TTL");
    assert.match(cookie, new RegExp(`Max-Age=${auth.SESSION_TTL}`), "cookie max-age must match the TTL");
});

test("gate: the issued cookie unlocks the API", async () => {
    const login = await fetch(base() + "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "changeme" }),
    });
    const token = setCookies(login)[0].split(";")[0];

    const res = await fetch(base() + "/api/state", { headers: { cookie: token } });
    assert.equal(res.status, 200);
});

test("gate: API rejects a missing or tampered cookie", async () => {
    const anonymous = await fetch(base() + "/api/state");
    assert.equal(anonymous.status, 401);

    const forged = await fetch(base() + "/api/state", {
        headers: { cookie: "auth_token=eyJhbGciOiJIUzI1NiJ9.forged.signature" },
    });
    assert.equal(forged.status, 401);

    // A token signed with the wrong secret must not pass either.
    const wrongSecret = jwt.sign({ sub: "admin", role: "admin" }, "not-the-real-secret", { expiresIn: 3600 });
    const foreign = await fetch(base() + "/api/state", {
        headers: { cookie: `auth_token=${wrongSecret}` },
    });
    assert.equal(foreign.status, 401);
});

test("login: logout clears the session cookie", async () => {
    const res = await fetch(base() + "/api/auth/logout", { method: "POST" });
    assert.equal(res.status, 200);
    const cookies = setCookies(res);
    assert.ok(cookies.length >= 1, "logout must emit a clearing cookie");
    assert.match(cookies[0], /auth_token=;|Expires=Thu, 01 Jan 1970/i);
});

test("password: change requires the current password and rotates it", async () => {
    const wrongCurrent = await fetch(base() + "/api/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ current: "not-the-password", next: "newpass123" }),
    });
    assert.equal(wrongCurrent.status, 401, "a wrong current password must be rejected");

    const login = await fetch(base() + "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "changeme" }),
    });
    const token = setCookies(login)[0].split(";")[0];

    const changed = await fetch(base() + "/api/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: token },
        body: JSON.stringify({ current: "changeme", next: "newpass123" }),
    });
    assert.equal(changed.status, 200);

    const oldPassword = await fetch(base() + "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "changeme" }),
    });
    assert.equal(oldPassword.status, 401, "the old password must stop working");

    const newPassword = await fetch(base() + "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "newpass123" }),
    });
    assert.equal(newPassword.status, 200, "the new password must work");
});

test("login: 10 failed attempts per minute, 11th gets 429 + Retry-After", async () => {
    assert.equal(auth.LOGIN_WINDOW_MS, 60 * 1000, "the window must be one minute");
    assert.equal(auth.LOGIN_MAX_TRIES, 10, "the failure budget must be 10");
    testDb.prepare("DELETE FROM login_attempts").run();

    for (let attempt = 0; attempt < auth.LOGIN_MAX_TRIES; attempt += 1) {
        const res = await fetch(base() + "/api/auth/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password: `wrong-${attempt}` }),
        });
        assert.equal(res.status, 401, `attempt ${attempt + 1} should be a plain rejection`);
    }

    const blocked = await fetch(base() + "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong-one-too-many" }),
    });
    assert.equal(blocked.status, 429, "the 11th failed attempt must be blocked");
    const retryAfter = Number(blocked.headers.get("retry-after"));
    assert.ok(retryAfter > 0 && retryAfter <= 60, `Retry-After must be within a minute, got ${retryAfter}`);
    const body = await blocked.json();
    assert.equal(body.retryAfter, retryAfter);
    assert.doesNotMatch(body.error, /15 minutes/i, "the old 15-minute lockout wording must be gone");
});

test("login: the limit resets once failures are older than one minute", async () => {
    // Move the clock forward by ageing only the failed rows out of the rolling
    // window, instead of sleeping 60 s. Successful rows are left untouched.
    testDb.prepare("UPDATE login_attempts SET ts = ts - ? WHERE success = 0")
        .run(auth.LOGIN_WINDOW_MS + 1000);

    const res = await fetch(base() + "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "still-wrong" }),
    });
    assert.equal(res.status, 401, "the budget must reset after one minute, with no 15-minute lockout");
    assert.equal(res.headers.get("retry-after"), null);
});

test("login: successful attempts do not consume the failure budget", async () => {
    testDb.prepare("DELETE FROM login_attempts").run();
    // The password was rotated to newpass123 by the change-password test above.
    for (let attempt = 0; attempt < auth.LOGIN_MAX_TRIES; attempt += 1) {
        const res = await fetch(base() + "/api/auth/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password: "newpass123" }),
        });
        assert.equal(res.status, 200, `successful login ${attempt + 1} must be accepted`);
    }

    const wrong = await fetch(base() + "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "definitely-wrong" }),
    });
    assert.equal(wrong.status, 401, "successes must not count toward the 10/minute limit");
});
