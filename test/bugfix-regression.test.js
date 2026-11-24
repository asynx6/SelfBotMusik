"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { searchTracks } = require("../modules/player");
const { PlayerController, LOOP_MODES } = require("../modules/player-controller");
const { BaseEngine } = require("../modules/engines/base");

function makeMockPoru(responses) {
    const calls = [];
    return {
        nodes: new Map([["main", { isConnected: true }]]),
        _calls: calls,
        async resolve({ query, source, requester }) {
            calls.push({ query, source, requester });
            return responses[calls.length - 1] || { loadType: "empty", tracks: [] };
        },
    };
}

class MockEngine extends BaseEngine {
    constructor() { super(); this.playedTrack = null; this.setLoopCalls = []; }
    async play(trackRow) { this.playedTrack = trackRow; }
    async pause() {}
    async resume() {}
    async stop() {}
    async setVolume() {}
    getPositionMs() { return 0; }
    async destroy() {}
}

// BUG 2: search dashboard harus 1 hasil terbaik, bukan semua kandidat.
test("BUG2: text search always returns the single best match, even with opts.all", async () => {
    const candidates = [
        { info: { identifier: "c1", title: "Sporty One", sourceName: "youtube" } },
        { info: { identifier: "c2", title: "Sporty Two", sourceName: "youtube" } },
        { info: { identifier: "c3", title: "Sporty Three", sourceName: "youtube" } },
    ];
    const out = await searchTracks(
        makeMockPoru([{ loadType: "search", tracks: candidates }]),
        "sporty", "req", { all: true }
    );
    assert.equal(out.length, 1, "dashboard search must return exactly one track");
    assert.equal(out[0].info.title, "Sporty One", "must be the first/best match");
});

// BUG 4: mode loop HARUS sinkron ke Poru internal supaya tidak ada dua scheduler.
test("BUG4: PC.setLoop is single source of truth — controller never calls Poru.setLoop", async () => {
    const engine = new MockEngine();
    const controller = new PlayerController({
        isLavalinkReady: () => true,
        createLavalinkEngine: () => engine,
    });
    await controller.enqueue([{ id: 1, title: "T1" }], "user");
    controller.setLoop(LOOP_MODES.QUEUE);
    assert.equal(controller.loop, LOOP_MODES.QUEUE);
    // The controller owns the queue; it must not reach into Poru's loop at all.
    assert.equal(typeof controller.setPoruLoop, "undefined", "no second loop owner on the controller");
    await controller.destroy();
});

// BUG 5: error banner only for fresh failures — sukses harus clear.
test("BUG5: a successful play clears currentError so no stale error banner shows", async () => {
    const engine = new MockEngine();
    const controller = new PlayerController({
        isLavalinkReady: () => true,
        createLavalinkEngine: () => engine,
    });
    await controller.enqueue([{ id: 1, title: "T1" }], "user");
    controller.currentError = new Error("old failure");
    assert.notEqual(controller.getSnapshot().lastError, null, "precondition: error visible");
    await controller.playCurrent();
    assert.equal(controller.getSnapshot().lastError, null, "success must clear stale error");
    await controller.destroy();
});

// BUG 1: Lavalink ready harus satu sumber — pakai state.connected, bukan node flag doang.
test("BUG1: unit test guard — isLavalinkReady comes from State.connected only", () => {
    const idx = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
    const m = idx.match(/isLavalinkReady:\s*\([^)]*\)\s*=>\s*([^,\n]+)/g) || [];
    assert(m.length >= 1, "isLavalinkReady adapters must exist");
    for (const line of m) {
        assert(
            line.includes("State.connected"),
            `isLavalinkReady must read State.connected, got: ${line}`
        );
    }
});
