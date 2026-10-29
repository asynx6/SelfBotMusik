"use strict";

const test = require("node:test");
const assert = require("node:assert");
const Database = require("better-sqlite3");
const dbModule = require("../modules/database");

// The production schema, applied to a fresh in-memory database.
const SCHEMA_SQL = dbModule.SCHEMA_SQL;

const EXPECTED_TABLES = [
    "audit_log",
    "downloads",
    "history",
    "likes",
    "login_attempts",
    "playlist_tracks",
    "playlists",
    "settings",
    "tracks",
    "users",
];

function listTables(db) {
    return db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r) => r.name);
}

test("schema creates all library tables and keeps the existing ones", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    assert.doesNotThrow(() => db.exec(SCHEMA_SQL));
    assert.deepEqual(listTables(db), EXPECTED_TABLES);
});

test("schema is idempotent — re-running exec does not throw", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    assert.doesNotThrow(() => db.exec(SCHEMA_SQL));
    assert.deepEqual(listTables(db), EXPECTED_TABLES);
});

test("foreign keys are enforced on playlist_tracks / likes / history / downloads", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);

    db.prepare(
        "INSERT INTO tracks (id, source_key, source_type, title, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(1, "youtube:abc", "lavalink", "Test", Date.now());
    db.prepare("INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
        1,
        "P",
        Date.now(),
        Date.now()
    );
    db.prepare(
        "INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)"
    ).run(1, 1, 0, Date.now());

    const FK = /FOREIGN KEY|foreign key/i;
    assert.throws(
        () =>
            db
                .prepare(
                    "INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)"
                )
                .run(999, 1, 0, Date.now()),
        FK
    );
    assert.throws(
        () =>
            db.prepare("INSERT INTO likes (track_id, liked_at) VALUES (?, ?)").run(999, Date.now()),
        FK
    );
    assert.throws(
        () =>
            db.prepare("INSERT INTO history (track_id, played_at) VALUES (?, ?)").run(999, Date.now()),
        FK
    );
    assert.throws(
        () =>
            db.prepare("INSERT INTO downloads (track_id, status, created_at) VALUES (?, ?, ?)").run(
                999,
                "queued",
                Date.now()
            ),
        FK
    );
});

test("ensureDefaults seeds the six foundation settings exactly once", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);

    dbModule.ensureDefaults(db);

    const map = {};
    for (const r of db.prepare("SELECT key, value FROM settings").all()) map[r.key] = r.value;

    assert.deepEqual(map, {
        download_concurrency: "3",
        max_upload_mb: "200",
        library_quota_gb: "10",
        ytdlp_path: "yt-dlp",
        ffmpeg_path: "ffmpeg",
        chat_requests_enabled: "false",
    });

    // Idempotent: a second call must not duplicate rows.
    dbModule.ensureDefaults(db);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM settings").get().c, 6);
});

test("ensureDefaults never overwrites an existing user value", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);

    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("download_concurrency", "8");

    dbModule.ensureDefaults(db);

    const v = db.prepare("SELECT value FROM settings WHERE key = ?").get("download_concurrency").value;
    assert.equal(v, "8");
});

// Boot-time seeding against the real module: requiring modules/database.js
// must have already run ensureDefaults() against the on-disk DB. Exact values
// are checked above against a fresh in-memory DB; here we only assert the keys
// exist, since a real DB may already carry user overrides.
test("modules/database.js seeds the five foundation settings on boot", () => {
    const all = dbModule.getAllSettings();
    for (const key of Object.keys(dbModule.DEFAULT_SETTINGS)) {
        assert.ok(key in all, `missing default setting: ${key}`);
        assert.equal(typeof all[key], "string");
    }
});
