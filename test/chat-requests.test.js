"use strict";

const test = require("node:test");
const assert = require("node:assert");

// searchTracksAuto: test the multi-source fallback and playlist handling.
const { searchTracksAuto } = require("../modules/player");

function makeMockPoru(responses) {
    // responses: array of { loadType, tracks, playlist } returned in order
    const calls = [];
    return {
        nodes: new Map([
            ["main", { isConnected: true }],
        ]),
        _calls: calls,
        async resolve({ query, source, requester }) {
            calls.push({ query, source, requester });
            const res = responses[calls.length - 1];
            if (!res) return { loadType: "empty", tracks: [] };
            return res;
        },
    };
}

test("searchTracksAuto: URL query passes through as-is, single call", async () => {
    const poru = makeMockPoru([
        { loadType: "track", tracks: [{ info: { identifier: "x", title: "T", sourceName: "http" } }] },
    ]);
    const out = await searchTracksAuto(poru, "https://open.spotify.com/playlist/abc", "req", ["spsearch"]);
    assert.equal(poru._calls.length, 1);
    assert.equal(poru._calls[0].source, undefined);
    assert.equal(out.tracks.length, 1);
    assert.equal(out.playlistName, null);
});

test("searchTracksAuto: plain title tries ytsearch first, falls back to next source", async () => {
    const poru = makeMockPoru([
        { loadType: "empty", tracks: [] },
        { loadType: "track", tracks: [{ info: { identifier: "y", title: "Found on 2nd", sourceName: "youtube" } }] },
    ]);
    const out = await searchTracksAuto(poru, "my song", "req", ["spsearch"]);
    assert.equal(poru._calls.length, 2);
    assert.equal(poru._calls[0].source, "ytsearch");
    assert.equal(poru._calls[1].source, "spsearch");
    assert.equal(out.tracks[0].info.title, "Found on 2nd");
});

test("searchTracksAuto: playlist loadType returns all tracks and playlist name", async () => {
    const tracks = [
        { info: { identifier: "p1", title: "S1", sourceName: "youtube" } },
        { info: { identifier: "p2", title: "S2", sourceName: "youtube" } },
        { info: { identifier: "p3", title: "S3", sourceName: "youtube" } },
    ];
    const poru = makeMockPoru([
        { loadType: "playlist", tracks, playlist: { name: "Chill Hits" } },
    ]);
    const out = await searchTracksAuto(poru, "https://open.spotify.com/playlist/xyz", "req", []);
    assert.equal(out.playlistName, "Chill Hits");
    assert.equal(out.tracks.length, 3);
});

test("searchTracksAuto: all sources empty throws last error", async () => {
    const poru = makeMockPoru([
        { loadType: "empty", tracks: [] },
        { loadType: "empty", tracks: [] },
        { loadType: "empty", tracks: [] },
        { loadType: "empty", tracks: [] },
    ]);
    await assert.rejects(
        () => searchTracksAuto(poru, "nothing matches", "req", ["spsearch", "scsearch"]),
        /No results/
    );
});
