"use strict";

/**
 * Spotify (and the other lavasrc metadata providers) resolve to a track whose
 * `encoded` is valid but whose source cannot actually be streamed by the node.
 * updatePlayer returns 200, Lavalink then sends no audio frame at all: position
 * stays 0 and the stall watchdog reports "audio tidak keluar".
 *
 * The engine must mirror those rows to a source the node can stream
 * (ytsearch by "artist title") instead of handing the metadata track over.
 */

const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const { LavalinkEngine } = require("../modules/engines/lavalink");

function harness(resolver) {
    const poru = new EventEmitter();
    poru.players = new Map();
    poru.resolve = resolver;

    const updates = [];
    const player = {
        guildId: "g1",
        queue: [],
        node: {
            sessionId: "sess",
            rest: { updatePlayer: async (payload) => { updates.push(payload); return {}; } },
        },
        setVolume: async () => {},
    };
    poru.players.set("g1", player);

    return { poru, player, engine: new LavalinkEngine({ poru, guildId: "g1" }), updates };
}

const spotifyTrack = {
    track: "ENC-SPOTIFY",
    info: { sourceName: "spotify", title: "Die On This Hill", author: "SIENNA SPIRO", length: 217008 },
};
const youtubeTrack = {
    track: "ENC-YOUTUBE",
    info: { sourceName: "youtube", title: "SIENNA SPIRO - Die On This Hill", author: "SIENNA SPIRO", length: 217008 },
};

test("a metadata-only track is mirrored to a playable source before playing", async () => {
    const calls = [];
    const { engine, updates } = harness(async (payload) => {
        calls.push(payload);
        if (payload.source === "ytsearch") return { loadType: "search", tracks: [youtubeTrack] };
        return { loadType: "track", tracks: [spotifyTrack] };
    });

    await engine.play({
        id: 253,
        title: "Die On This Hill",
        artist: "SIENNA SPRIO",
        uri: "https://open.spotify.com/track/7gkZNvBHfI30qG7hA0eopT",
        source_type: "lavalink",
        source_name: "spotify",
    });

    const sent = updates[updates.length - 1];
    assert.equal(sent.data.track.encoded, "ENC-YOUTUBE", "the playable mirror must be loaded, not the metadata track");

    const mirror = calls.find((c) => c.source === "ytsearch");
    assert.ok(mirror, "must search a playable source");
    assert.match(mirror.query, /Die On This Hill/);
});

test("a natively playable track is loaded as-is, with no extra resolve", async () => {
    const calls = [];
    const { engine, updates } = harness(async (payload) => {
        calls.push(payload);
        return { loadType: "track", tracks: [youtubeTrack] };
    });

    await engine.play({
        id: 1,
        title: "SIENNA SPIRO - Die On This Hill",
        uri: "https://www.youtube.com/watch?v=abc",
        source_type: "lavalink",
        source_name: "youtube",
    });

    assert.equal(calls.length, 1, "no mirror search for a playable source");
    assert.equal(updates[updates.length - 1].data.track.encoded, "ENC-YOUTUBE");
});

test("when nothing playable can be found the error names the real problem", async () => {
    const { engine } = harness(async (payload) => {
        if (payload.source === "ytsearch") return { loadType: "empty", tracks: [] };
        return { loadType: "track", tracks: [spotifyTrack] };
    });

    await assert.rejects(
        () => engine.play({
            id: 254,
            title: "Lovesong",
            artist: "X",
            uri: "https://open.spotify.com/track/2PPN1HFpVotjq7oJIqQbnx",
            source_type: "lavalink",
            source_name: "spotify",
        }),
        /mirror|sumber/i
    );
});
