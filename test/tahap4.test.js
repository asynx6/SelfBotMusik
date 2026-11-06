"use strict";

const test = require("node:test");
const assert = require("node:assert");
const Database = require("better-sqlite3");
const { SCHEMA_SQL } = require("../modules/database");
const { getTrackScore, getAutoplayRecommendations, WEIGHTS } = require("../modules/recommendations");
const PlayerController = require("../modules/player-controller");

function setupTestDb() {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    return db;
}

test("Recommendations: scoring weights applied correctly", () => {
    const base = { id: 1, title: "Track", artist: "Artist" };

    // Base score
    const s1 = getTrackScore(base);
    assert.equal(s1, WEIGHTS.LIBRARY_BASE);

    // Local file bonus
    const local = { ...base, file_path: "1.mp3" };
    const s2 = getTrackScore(local);
    assert.equal(s2, WEIGHTS.LIBRARY_BASE + WEIGHTS.LOCAL_BONUS);

    // Liked bonus
    const liked = { ...base, is_liked: 1 };
    const s3 = getTrackScore(liked);
    assert.equal(s3, WEIGHTS.LIBRARY_BASE + WEIGHTS.LIKED_BONUS);

    // Frequent play bonus
    const frequent = { ...base, play_count: 10 };
    const s4 = getTrackScore(frequent);
    assert.equal(s4, WEIGHTS.LIBRARY_BASE + WEIGHTS.FREQUENT_PLAY_BONUS);

    // Same artist context bonus
    const context = { currentTrack: { artist: "Artist" } };
    const s5 = getTrackScore(base, context);
    assert.equal(s5, WEIGHTS.LIBRARY_BASE + WEIGHTS.SAME_ARTIST_BONUS);
});

test("Autoplay: onTrackEnd returns a recommendation without mutating the queue", async () => {
    const db = setupTestDb();
    db.prepare("INSERT INTO tracks (id, source_key, source_type, title, artist, created_at, play_count) VALUES (1, 'k1', 'lavalink', 'Song A', 'Artist A', 1, 5)").run();
    db.prepare("INSERT INTO tracks (id, source_key, source_type, title, artist, created_at, play_count) VALUES (2, 'k2', 'lavalink', 'Song B', 'Artist A', 2, 3)").run();
    db.prepare("INSERT INTO tracks (id, source_key, source_type, title, artist, created_at, play_count) VALUES (3, 'k3', 'lavalink', 'Song C', 'Other', 3, 1)").run();

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
        db: db,
        autoplayEnabled: true,
    });

    // Manually set autoplay provider (index.js does this at boot)
    const { onTrackEnd } = require("../modules/recommendations");
    pc.setAutoplayProvider((lastTrack) => onTrackEnd(lastTrack, pc, { customDb: db }));

    const currentTrack = { id: 1, title: "Song A", artist: "Artist A" };
    // Pass the test database explicitly: without it the recommender reads the
    // real data/app.sqlite, which makes this test depend on unrelated state.
    const nextTrack = await onTrackEnd(currentTrack, pc, { customDb: db });

    // Should have recommended a track from library
    assert(nextTrack !== null, "Should have found a recommendation");
    assert(nextTrack.id !== currentTrack.id, "Should not recommend the current track itself");
    assert.equal(pc.queue.length, 0, "the controller owns queue insertion; no duplicate");
});
