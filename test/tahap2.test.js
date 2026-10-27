"use strict";

const test = require("node:test");
const assert = require("node:assert");
const Database = require("better-sqlite3");
const { SCHEMA_SQL } = require("../modules/database");
const playlists = require("../modules/playlists");
const likes = require("../modules/likes");
const history = require("../modules/history");
const PlayerController = require("../modules/player-controller");

function setupTestDb() {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    return db;
}

test("Playlists: create, get, list, update, and delete", () => {
    const db = setupTestDb();

    // Create
    const p1 = playlists.createPlaylist("Chill Mix", "My chill tracks", db);
    assert.equal(p1.name, "Chill Mix");
    assert.equal(p1.description, "My chill tracks");
    assert.equal(p1.track_count, 0);

    // Get
    const fetched = playlists.getPlaylistById(p1.id, db);
    assert.equal(fetched.name, "Chill Mix");

    // List
    const list1 = playlists.listPlaylists({}, db);
    assert.equal(list1.total, 1);
    assert.equal(list1.playlists[0].name, "Chill Mix");

    // Update
    const updated = playlists.updatePlaylist(p1.id, { name: "Super Chill", description: "Updated" }, db);
    assert.equal(updated.name, "Super Chill");
    assert.equal(updated.description, "Updated");

    // Delete
    const del = playlists.deletePlaylist(p1.id, db);
    assert.equal(del.deleted, true);
    assert.equal(playlists.getPlaylistById(p1.id, db), null);
    assert.equal(playlists.listPlaylists({}, db).total, 0);
});

test("Playlists: add tracks, prevent duplicates, reorder, and remove", () => {
    const db = setupTestDb();
    const p = playlists.createPlaylist("Rock", null, db);

    // Insert dummy tracks
    db.prepare("INSERT INTO tracks (id, source_key, source_type, title, created_at) VALUES (1, 'k1', 'lavalink', 'Track 1', 1)").run();
    db.prepare("INSERT INTO tracks (id, source_key, source_type, title, created_at) VALUES (2, 'k2', 'lavalink', 'Track 2', 2)").run();
    db.prepare("INSERT INTO tracks (id, source_key, source_type, title, created_at) VALUES (3, 'k3', 'lavalink', 'Track 3', 3)").run();

    // Add tracks
    const r1 = playlists.addTrackToPlaylist(p.id, 1, db);
    const r2 = playlists.addTrackToPlaylist(p.id, 2, db);
    const r3 = playlists.addTrackToPlaylist(p.id, 3, db);
    assert.equal(r1.added, true);
    assert.equal(r1.position, 0);
    assert.equal(r2.position, 1);
    assert.equal(r3.position, 2);

    // Duplicate check
    const dup = playlists.addTrackToPlaylist(p.id, 1, db);
    assert.equal(dup.added, false);
    assert.equal(dup.duplicate, true);

    // Check track count in list
    const fetchedP = playlists.getPlaylistById(p.id, db);
    assert.equal(fetchedP.track_count, 3);

    // Get tracks
    const data = playlists.getPlaylistTracks(p.id, db);
    assert.equal(data.tracks.length, 3);
    assert.equal(data.tracks[0].title, "Track 1");

    // Reorder tracks: [3, 1, 2]
    const reordered = playlists.reorderPlaylistTracks(p.id, [3, 1, 2], db);
    assert.equal(reordered.tracks[0].id, 3);
    assert.equal(reordered.tracks[1].id, 1);
    assert.equal(reordered.tracks[2].id, 2);

    // Remove track 1
    const rem = playlists.removeTrackFromPlaylist(p.id, 1, db);
    assert.equal(rem.removed, true);
    const remaining = playlists.getPlaylistTracks(p.id, db);
    assert.equal(remaining.tracks.length, 2);
    assert.equal(remaining.tracks.find(t => t.id === 1), undefined);
});

test("Likes: toggle like, isLiked, listLikes", () => {
    const db = setupTestDb();
    db.prepare("INSERT INTO tracks (id, source_key, source_type, title, created_at) VALUES (1, 'k1', 'lavalink', 'Track 1', 1)").run();
    db.prepare("INSERT INTO tracks (id, source_key, source_type, title, created_at) VALUES (2, 'k2', 'lavalink', 'Track 2', 2)").run();

    // Initially not liked
    assert.equal(likes.isLiked(1, db), false);

    // Toggle on
    const r1 = likes.toggleLike(1, db);
    assert.equal(r1.liked, true);
    assert.equal(likes.isLiked(1, db), true);

    // Toggle off
    const r2 = likes.toggleLike(1, db);
    assert.equal(r2.liked, false);
    assert.equal(likes.isLiked(1, db), false);

    // Like both
    likes.toggleLike(1, db);
    likes.toggleLike(2, db);

    const list = likes.listLikes({}, db);
    assert.equal(list.total, 2);
    assert.equal(list.tracks.length, 2);
});

test("History: recordPlay and listHistory", () => {
    const db = setupTestDb();
    db.prepare("INSERT INTO tracks (id, source_key, source_type, title, created_at) VALUES (1, 'k1', 'lavalink', 'Track 1', 1)").run();

    history.recordHistory(1, 15000, db);
    history.recordHistory(1, 30000, db);

    const hist = history.listHistory({}, db);
    assert.equal(hist.total, 2);
    assert.equal(hist.history[0].ms_played, 30000);
});

test("PlayerController: playNext, shuffle, and reorder", async () => {
    class MockEngine {
        constructor() { this.name = "mock"; }
        async play() {}
        async stop() {}
        async destroy() {}
        getPositionMs() { return 0; }
    }

    const pc = new PlayerController({
        createLavalinkEngine: () => new MockEngine(),
        createLocalEngine: () => new MockEngine(),
    });

    const t1 = { id: 1, title: "Song 1", uri: "u1" };
    const t2 = { id: 2, title: "Song 2", uri: "u2" };
    const t3 = { id: 3, title: "Song 3", uri: "u3" };
    const t4 = { id: 4, title: "Song 4", uri: "u4" };

    await pc.enqueue([t1, t2, t3], "user");
    assert.equal(pc.queue.length, 3);
    assert.equal(pc.currentIndex, 0);

    // Play next: inserts right after currently playing track (index 0)
    pc.playNext([t4], "user");
    assert.equal(pc.queue.length, 4);
    assert.equal(pc.queue[1].track.title, "Song 4");
    assert.equal(pc.queue[2].track.title, "Song 2");

    // Reorder upcoming: move Song 4 (index 1) to end (index 3)
    const reord = pc.reorder(1, 3);
    assert.equal(reord.moved, true);
    assert.equal(pc.queue[3].track.title, "Song 4");

    // Shuffle upcoming tracks
    const shuf = pc.shuffle();
    assert.equal(shuf.shuffled, true);
    // Currently playing track stays at index 0
    assert.equal(pc.queue[0].track.title, "Song 1");
});
