"use strict";

// Task 9: State compatibility between PlayerController snapshots and the
// legacy WebSocket `State` schema consumed by the dashboard.

const test = require("node:test");
const assert = require("node:assert");
const stateMod = require("../modules/state");
const PlayerController = require("../modules/player-controller");

// Legacy schema every WS client expects (see modules/state.js defaults).
const LEGACY_KEYS = {
    connected: "boolean",
    botReady: "boolean",
    voiceConnected: "boolean",
    playing: ["object", "null"],   // serialized track or null
    queue: "object",               // array
    paused: "boolean",
    volume: "number",
    position: "number",
    loop: "number",
    voiceChannelId: "string",
    guildId: "string",
    lastError: ["string", "null"],
    needsSetup: "boolean",
};

function assertSchema(obj, label) {
    for (const [key, spec] of Object.entries(LEGACY_KEYS)) {
        const types = Array.isArray(spec) ? spec : [spec];
        assert.ok(
            types.includes(obj[key] === null ? "null" : typeof obj[key]),
            `${label}: State.${key} should be ${types.join("|")}, got ${typeof obj[key]} (${JSON.stringify(obj[key])})`
        );
    }
}

test("state.snapshot() matches legacy schema by default", () => {
    const snap = stateMod.snapshot();
    assertSchema(snap, "default");
    assert.ok(Array.isArray(snap.queue));
    assert.ok(snap.volume >= 0 && snap.volume <= 200);
    assert.ok(snap.loop >= 0 && snap.loop <= 2);
});

// Minimal fake engine for the controller.
class FakeEngine {
    constructor() { this.volume = 100; }
    async play() {}
    async pause() {}
    async resume() {}
    async stop() {}
    async setVolume(v) { this.volume = v; }
    getPositionMs() { return 12345; }
    async destroy() {}
}

function makeController() {
    return new PlayerController({
        dataDir: "/nonexistent",
        createLocalEngine: () => new FakeEngine(),
        createLavalinkEngine: () => new FakeEngine(),
        isLavalinkReady: () => true,
    });
}

// Patch a controller snapshot onto State the same way index.js
// syncStateFromPlayer() does, then verify the merged snapshot.
function syncFromController(controller) {
    const snap = controller.getSnapshot();
    stateMod.patch({
        playing: snap.playing || null,
        queue: Array.isArray(snap.queue) ? snap.queue : [],
        paused: !!snap.paused,
        volume: Number.isFinite(snap.volume) ? snap.volume : 100,
        loop: Number.isFinite(snap.loop) ? snap.loop : 0,
        position: Number.isFinite(snap.position) ? snap.position : 0,
    });
}

test("controller snapshot patched into State keeps legacy schema", async () => {
    const pc = makeController();
    const track = { id: 1, title: "Song A", author: "Artist", duration_ms: 180000, uri: "u", encoded: "enc" };
    await pc.enqueue([track], "Tester");

    syncFromController(pc);
    const snap = stateMod.snapshot();
    assertSchema(snap, "playing");

    assert.ok(snap.playing && typeof snap.playing === "object");
    assert.equal(snap.playing.title, "Song A");
    assert.equal(snap.queue.length, 1);
    assert.equal(snap.queue[0].isCurrent, true);
    assert.equal(snap.position, 12345);
    assert.equal(typeof snap.paused, "boolean");

    // Pause and volume flow through the same path.
    await pc.pause();
    await pc.setVolume(150);
    pc.setLoop(2);
    syncFromController(pc);
    const snap2 = stateMod.snapshot();
    assertSchema(snap2, "paused+volume");
    assert.equal(snap2.paused, true);
    assert.equal(snap2.volume, 150);
    assert.equal(snap2.loop, 2);

    // Stop resets to empty-queue shape without breaking schema.
    await pc.stop();
    syncFromController(pc);
    const snap3 = stateMod.snapshot();
    assertSchema(snap3, "stopped");
    assert.equal(snap3.playing, null);
    assert.deepEqual(snap3.queue, []);
    await pc.destroy();
});

test("controller 'state' events drive State patches (WS bridge simulation)", async () => {
    const pc = makeController();
    let eventCount = 0;
    pc.on("state", () => { eventCount++; });

    await pc.enqueue([{ id: 2, title: "Song B", duration_ms: 90000 }], "X");
    assert.ok(eventCount > 0);
    syncFromController(pc);
    assert.equal(stateMod.snapshot().playing.title, "Song B");
    await pc.destroy();
});

test("snapshot() is a defensive copy (WS clients cannot mutate State)", () => {
    const s1 = stateMod.snapshot();
    s1.playing = { title: "hacked" };
    s1.queue.push("x");
    s1.volume = 999;
    const s2 = stateMod.snapshot();
    assert.notDeepEqual(s1.playing, s2.playing);
    assert.ok(!s2.queue.includes("x"));
    assert.notEqual(s2.volume, 999);
});
