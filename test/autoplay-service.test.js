"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createAutoplayService, similarity, normaliseKey } = require("../modules/autoplay");

const seed = { id: 1, title: "What If I Call", artist: "Alex Crichton" };

const candidate = (n, extra = {}) => ({
    title: `Song ${n}`,
    artist: n === 1 ? "Alex Crichton" : "Someone Else",
    uri: `https://example.com/${n}`,
    ...extra,
});

test("similarity rewards the same artist, local files and shared title words", () => {
    assert.ok(similarity(seed, candidate(1)) > similarity(seed, candidate(2)));
    assert.ok(similarity(seed, { ...candidate(2), file_path: "2.webm" })
        > similarity(seed, candidate(2)));
    assert.ok(similarity(seed, { title: "What If I Call (Live)", artist: "X" }) > 0);
});

test("prepare fills a deduplicated buffer while Lavalink is online", async () => {
    const queries = [];
    const service = createAutoplayService({
        isLavalinkReady: () => true,
        bufferSize: 3,
        getLibraryCandidates: async () => [candidate(10, { file_path: "10.webm" })],
        searchOnline: async (q) => {
            queries.push(q);
            return [candidate(1), candidate(1), candidate(2), candidate(3)];
        },
    });

    await service.prepare(seed);

    assert.ok(queries.length > 0, "Lavalink must be queried while online");
    assert.ok(queries[0].includes("Alex Crichton"), "query must be seeded from the playing track");
    assert.equal(service.size, 3);
    const first = await service.take(seed);
    assert.ok(first, "a prepared candidate is available immediately");
    assert.equal(service.size, 2);
});

test("explicit queue wins: candidates already queued are skipped", async () => {
    const queued = candidate(1);
    const service = createAutoplayService({
        isLavalinkReady: () => false,
        bufferSize: 2,
        getActiveKeys: () => [normaliseKey(queued)],
        getLibraryCandidates: async () => [queued, candidate(2)],
    });

    await service.prepare(seed);
    const picked = await service.take(seed);

    assert.equal(picked.title, "Song 2", "must not duplicate an explicitly queued track");
});

test("Lavalink offline: autoplay still works from the local library only", async () => {
    let onlineCalls = 0;
    const service = createAutoplayService({
        isLavalinkReady: () => false,
        searchOnline: async () => { onlineCalls++; return []; },
        getLibraryCandidates: async () => [candidate(5, { file_path: "5.webm" })],
    });

    await service.prepare(seed);
    const picked = await service.take(seed);

    assert.equal(onlineCalls, 0);
    assert.equal(picked.file_path, "5.webm");
});

test("notePlayed prevents the same track being offered again", async () => {
    const service = createAutoplayService({
        isLavalinkReady: () => false,
        getLibraryCandidates: async () => [candidate(7)],
    });
    service.notePlayed(candidate(7));
    await service.prepare(seed);
    assert.equal(await service.take(seed), null);
});
