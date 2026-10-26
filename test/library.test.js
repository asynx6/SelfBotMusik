"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Database = require("better-sqlite3");

// Stub database module in require.cache before loading library module
const dbModulePath = require.resolve("../modules/database");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbm-lib-"));
const testDb = new Database(":memory:");
testDb.pragma("foreign_keys = ON");

// Create minimal schema for testing
testDb.exec(`
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
`);

require.cache[dbModulePath] = {
    id: dbModulePath,
    filename: dbModulePath,
    loaded: true,
    exports: {
        db: testDb,
        DATA_DIR: tmpDir,
        getSetting: () => null,
        setSetting: () => {},
        getAllSettings: () => ({}),
        audit: () => {},
    },
};

const library = require("../modules/library");

test.after(() => {
    try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* cleanup */ }
});

test("upsertFromLavalink creates track row and deduplicates by source_key", () => {
    const info1 = {
        sourceName: "youtube",
        identifier: "dQw4w9WgXcQ",
        title: "Never Gonna Give You Up",
        author: "Rick Astley",
        album: "Whenever You Need Somebody",
        length: 213000,
        uri: "https://youtube.com/watch?v=dQw4w9WgXcQ",
        artworkUrl: "https://example.com/cover.jpg",
    };

    const track1 = library.upsertFromLavalink(info1);
    assert.ok(track1.id > 0);
    assert.equal(track1.source_key, "youtube:dQw4w9WgXcQ");
    assert.equal(track1.source_type, "lavalink");
    assert.equal(track1.source_name, "youtube");
    assert.equal(track1.identifier, "dQw4w9WgXcQ");
    assert.equal(track1.title, "Never Gonna Give You Up");
    assert.equal(track1.artist, "Rick Astley");
    assert.equal(track1.album, "Whenever You Need Somebody");
    assert.equal(track1.duration_ms, 213000);
    assert.equal(track1.uri, "https://youtube.com/watch?v=dQw4w9WgXcQ");
    assert.equal(track1.cover_url, "https://example.com/cover.jpg");
    assert.equal(track1.file_path, null);

    // Calling again returns existing row without modification
    const dup = library.upsertFromLavalink({
        sourceName: "youtube",
        identifier: "dQw4w9WgXcQ",
        title: "Modified Title Should Be Ignored",
    });
    assert.equal(dup.id, track1.id);
    assert.equal(dup.title, "Never Gonna Give You Up");

    // Fallbacks for missing fields
    const minimal = library.upsertFromLavalink({
        sourceName: "soundcloud",
        identifier: "123456",
    });
    assert.equal(minimal.title, "Unknown");
    assert.equal(minimal.artist, null);
    assert.equal(minimal.album, null);
    assert.equal(minimal.duration_ms, null);
    assert.equal(minimal.uri, null);
    assert.equal(minimal.cover_url, null);
});

test("getById and finders return correct row or null", () => {
    const info = {
        sourceName: "spotify",
        identifier: "spot1",
        title: "Track A",
        author: "Artist X",
    };
    const row = library.upsertFromLavalink(info);

    assert.equal(library.getById(row.id).title, "Track A");
    assert.equal(library.getById(99999), null);
    assert.equal(library.getById(null), null);

    assert.equal(library.findBySourceKey("spotify:spot1").id, row.id);
    assert.equal(library.findBySourceKey("nonexistent"), null);

    // sha256 finder
    assert.equal(library.findBySha256("aabbcc"), null);
    library.attachFile(row.id, {
        filePath: `${row.id}.mp3`,
        fileSize: 1024,
        format: "mp3",
        sha256: "aabbcc",
    });
    assert.equal(library.findBySha256("aabbcc").id, row.id);
});

test("attachFile and removeFile manage database columns and physical files", () => {
    const row = library.upsertFromLavalink({
        sourceName: "yt",
        identifier: "attach_test_1",
        title: "Attach Test",
    });

    const fileName = `${row.id}.mp3`;
    const absPath = path.join(library.getLibraryDir(), fileName);
    fs.writeFileSync(absPath, "dummy audio content 12345");

    const attached = library.attachFile(row.id, {
        filePath: fileName,
        fileSize: 23,
        format: "mp3",
        sha256: "testsha256hash",
    });

    assert.equal(attached.file_path, fileName);
    assert.equal(attached.file_size, 23);
    assert.equal(attached.format, "mp3");
    assert.equal(attached.sha256, "testsha256hash");
    assert.ok(attached.downloaded_at > 0);
    assert.ok(fs.existsSync(absPath));

    // removeFile deletes physical file and resets columns
    const removed = library.removeFile(row.id);
    assert.equal(removed.file_path, null);
    assert.equal(removed.file_size, null);
    assert.equal(removed.format, null);
    assert.equal(removed.sha256, null);
    assert.equal(removed.downloaded_at, null);
    assert.equal(fs.existsSync(absPath), false);

    // removeFile on row where physical file does not exist still succeeds
    const removedAgain = library.removeFile(row.id);
    assert.equal(removedAgain.file_path, null);
});

test("remove deletes database row and physical audio and cover files", () => {
    const row = library.upsertFromLavalink({
        sourceName: "yt",
        identifier: "remove_test_1",
        title: "Remove Test",
    });

    const audioName = `${row.id}.opus`;
    const coverName = `${row.id}.jpg`;
    const audioPath = path.join(library.getLibraryDir(), audioName);
    const coverPath = path.join(library.getCoversDir(), coverName);
    fs.writeFileSync(audioPath, "dummy opus audio");
    fs.writeFileSync(coverPath, "dummy cover image");

    library.attachFile(row.id, {
        filePath: audioName,
        fileSize: 16,
        format: "opus",
        sha256: "hash123",
    });

    // Also manually set cover_path on row
    testDb.prepare("UPDATE tracks SET cover_path = ? WHERE id = ?").run(coverName, row.id);

    assert.ok(fs.existsSync(audioPath));
    assert.ok(fs.existsSync(coverPath));

    const res = library.remove(row.id);
    assert.deepEqual(res, { deleted: true });

    assert.equal(fs.existsSync(audioPath), false);
    assert.equal(fs.existsSync(coverPath), false);
    assert.equal(library.getById(row.id), null);
});

test("list filters by all, local, reference, and query substring match", () => {
    testDb.exec("DELETE FROM tracks");

    const t1 = library.upsertFromLavalink({
        sourceName: "src",
        identifier: "id1",
        title: "Bohemian Rhapsody",
        author: "Queen",
        album: "A Night at the Opera",
    });
    const t2 = library.upsertFromLavalink({
        sourceName: "src",
        identifier: "id2",
        title: "Radio Ga Ga",
        author: "Queen",
        album: "The Works",
    });
    const t3 = library.upsertFromLavalink({
        sourceName: "src",
        identifier: "id3",
        title: "Hotel California",
        author: "Eagles",
        album: "Hotel California",
    });

    // Make t1 local
    library.attachFile(t1.id, {
        filePath: `${t1.id}.flac`,
        fileSize: 5000,
        format: "flac",
        sha256: "flachash",
    });

    // Filter 'all'
    const all = library.list({ filter: "all" });
    assert.equal(all.total, 3);
    assert.equal(all.tracks.length, 3);

    // Filter 'local'
    const local = library.list({ filter: "local" });
    assert.equal(local.total, 1);
    assert.equal(local.tracks[0].id, t1.id);

    // Filter 'reference'
    const reference = library.list({ filter: "reference" });
    assert.equal(reference.total, 2);
    assert.deepEqual(reference.tracks.map((t) => t.id).sort(), [t2.id, t3.id].sort());

    // Query match on title
    const qTitle = library.list({ query: "rhapsody" });
    assert.equal(qTitle.total, 1);
    assert.equal(qTitle.tracks[0].title, "Bohemian Rhapsody");

    // Query match on artist (Queen has 2 tracks)
    const qArtist = library.list({ query: "queen" });
    assert.equal(qArtist.total, 2);

    // Query match on album
    const qAlbum = library.list({ query: "opera" });
    assert.equal(qAlbum.total, 1);
    assert.equal(qAlbum.tracks[0].id, t1.id);

    // Combined query + filter
    const qCombined = library.list({ query: "queen", filter: "reference" });
    assert.equal(qCombined.total, 1);
    assert.equal(qCombined.tracks[0].id, t2.id);

    // Pagination
    const page1 = library.list({ limit: 2, offset: 0 });
    assert.equal(page1.tracks.length, 2);
    assert.equal(page1.total, 3);

    const page2 = library.list({ limit: 2, offset: 2 });
    assert.equal(page2.tracks.length, 1);
    assert.equal(page2.total, 3);
});

test("diskUsage calculates total size and count from data/library files", async () => {
    const libDir = library.getLibraryDir();

    // Clean existing test files in libDir
    for (const f of fs.readdirSync(libDir)) {
        fs.unlinkSync(path.join(libDir, f));
    }

    fs.writeFileSync(path.join(libDir, "101.mp3"), Buffer.alloc(1024 * 512)); // 512 KB
    fs.writeFileSync(path.join(libDir, "102.wav"), Buffer.alloc(1024 * 1024 * 2)); // 2 MB

    // Test synchronous property access
    const syncUsage = library.diskUsage();
    assert.equal(syncUsage.count, 2);
    assert.equal(syncUsage.bytes, 1024 * 512 + 1024 * 1024 * 2);
    assert.equal(syncUsage.mb, 2.5);

    // Test async / await access
    const asyncUsage = await library.diskUsage();
    assert.equal(asyncUsage.count, 2);
    assert.equal(asyncUsage.bytes, syncUsage.bytes);
    assert.equal(asyncUsage.mb, 2.5);
});

test("path traversal checks reject invalid file names and extensions", () => {
    // Malformed names / path traversal
    assert.throws(() => library.resolveFilePath("../secret.mp3"), /Invalid file path/);
    assert.throws(() => library.resolveFilePath("nested/42.mp3"), /Invalid file path/);
    assert.throws(() => library.resolveFilePath("/etc/passwd.mp3"), /Invalid file path/);
    assert.throws(() => library.resolveFilePath("evil.mp3"), /Invalid file path/);

    // Disallowed extension
    assert.throws(() => library.resolveFilePath("42.exe"), /Disallowed audio extension/);

    // Same for cover path
    assert.throws(() => library.resolveCoverPath("../cover.jpg"), /Invalid cover path/);
    assert.throws(() => library.resolveCoverPath("42.bat"), /Disallowed cover extension/);

    // attachFile validates input
    assert.throws(() => library.attachFile(1, { filePath: "../bad.mp3" }), /Invalid file path/);
    assert.throws(() => library.attachFile(1, { filePath: "1.exe" }), /Disallowed audio format/);
});
