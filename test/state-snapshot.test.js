"use strict";

const test = require("node:test");
const assert = require("node:assert");

const stateMod = require("../modules/state");

test("snapshot: returns a fresh object with every public field", () => {
    stateMod.patch({ volume: 55, loop: 2, position: 1234 });
    const snap = stateMod.snapshot();

    assert.notStrictEqual(snap, stateMod.State);
    for (const key of ["connected", "botReady", "voiceConnected", "playing", "queue", "paused", "volume", "loop", "position"]) {
        assert.ok(key in snap, `snapshot must expose "${key}"`);
    }
    assert.equal(snap.volume, 55);
    assert.equal(snap.loop, 2);
});

test("snapshot: callers cannot mutate the live queue array", () => {
    stateMod.patch({ queue: [{ id: 1, title: "a" }, { id: 2, title: "b" }] });

    const snap = stateMod.snapshot();
    snap.queue.push({ id: 99, title: "injected" });
    snap.queue[0].title = "mutated";

    assert.equal(stateMod.State.queue.length, 2, "live queue length is untouched");
    assert.notStrictEqual(snap.queue, stateMod.State.queue);
});

test("snapshot: tolerates a non-array queue without throwing", () => {
    stateMod.State.queue = null;
    const snap = stateMod.snapshot();
    assert.deepEqual(snap.queue, []);
    stateMod.State.queue = [];
});

test("emitter: listener limit is finite so leaks surface as a warning", () => {
    assert.ok(stateMod.emitter.getMaxListeners() > 0);
});
