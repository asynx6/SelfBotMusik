"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { BaseEngine } = require("../modules/engines/base");
const { PlayerController } = require("../modules/player-controller");

class MockEngine extends BaseEngine {
    constructor(name = "mock") { super(); this.name = name; this.playedTrack = null; }
    async play(trackRow) { this.playedTrack = trackRow; }
    async pause() {}
    async resume() {}
    async stop() {}
    async setVolume() {}
    getPositionMs() { return 0; }
    async destroy() {}
}

test("26. QUEUE loop keeps finished tracks: they move to the tail, not disappear", async () => {
    const engine = new MockEngine("lavalink");
    const controller = new PlayerController({
        isLavalinkReady: () => true,
        createLavalinkEngine: () => engine,
    });
    controller.setLoop(2); // QUEUE

    await controller.enqueue([1, 2, 3].map((i) => ({ id: i, title: `T${i}` })), "user");

    const titles = () => controller.queue.map((it) => it.track.title);
    assert.deepEqual(titles(), ["T1", "T2", "T3"]);

    // T1 finishes -> moves to the bottom, T2 becomes current.
    engine.emit("end", { reason: "finished" });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(titles(), ["T2", "T3", "T1"], "T1 must reappear at the tail");
    assert.equal(engine.playedTrack.title, "T2");

    // Every entry stays in the queue, so the dashboard list never shrinks.
    assert.equal(controller.queue.length, 3);
    const snap = controller.getSnapshot();
    assert.equal(snap.queue.length, 3, "snapshot must still expose all tracks");
    assert.equal(snap.queue[0].title, "T2");
    assert.equal(snap.queue[2].title, "T1");

    engine.emit("end", { reason: "finished" });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(titles(), ["T3", "T1", "T2"]);
    assert.equal(engine.playedTrack.title, "T3");

    await controller.destroy();
});

test("27. loop OFF drops finished tracks instead of rotating them", async () => {
    const engine = new MockEngine("lavalink");
    const controller = new PlayerController({
        isLavalinkReady: () => true,
        createLavalinkEngine: () => engine,
    });
    controller.setLoop(0); // OFF

    await controller.enqueue([1, 2].map((i) => ({ id: i, title: `T${i}` })), "user");
    engine.emit("end", { reason: "finished" });
    await new Promise((r) => setImmediate(r));

    // The list is not rotated: T2 is current and T1 is simply behind us.
    assert.equal(controller.currentIndex, 1);
    assert.equal(controller.getSnapshot().queue.length, 1, "only the upcoming track remains visible");

    await controller.destroy();
});

test("28. TRACK loop replays the same track without touching the queue", async () => {
    const engine = new MockEngine("lavalink");
    const controller = new PlayerController({
        isLavalinkReady: () => true,
        createLavalinkEngine: () => engine,
    });
    controller.setLoop(1); // TRACK

    await controller.enqueue([1, 2].map((i) => ({ id: i, title: `T${i}` })), "user");
    engine.emit("end", { reason: "finished" });
    await new Promise((r) => setImmediate(r));

    assert.equal(controller.currentIndex, 0, "index must stay on the same track");
    assert.equal(engine.playedTrack.title, "T1");
    assert.deepEqual(controller.queue.map((it) => it.track.title), ["T1", "T2"]);

    await controller.destroy();
});
