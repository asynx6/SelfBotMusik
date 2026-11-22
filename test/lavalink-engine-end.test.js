"use strict";

/**
 * Regression: a track that follows another one never advanced the queue.
 *
 * Our engine loads track B by sending `updatePlayer({ track })` to Lavalink.
 * Lavalink answers with TrackEndEvent(reason="replaced") for track A, and
 * `scripts/patch-poru.js` forwards that as `poru.emit("trackEnd")` so the
 * reason survives. LavalinkEngine's `_emitEnd` latched `_trackEnded = true`
 * on that "replaced", and its one-shot guard then swallowed the NEXT real
 * track end — music stopped while the queue still had tracks. Intermittent,
 * because it depended on whether the "replaced" packet arrived before or
 * after `play()` reset the flag.
 */

const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const { LavalinkEngine } = require("../modules/engines/lavalink");

function harness() {
    const poru = new EventEmitter();
    poru.players = new Map();
    poru.resolve = async () => ({ loadType: "empty", tracks: [] });

    const player = {
        guildId: "g1",
        queue: [],
        node: {
            sessionId: "sess",
            rest: { updatePlayer: async () => ({}) },
        },
        setVolume: async () => {},
    };
    poru.players.set("g1", player);

    const engine = new LavalinkEngine({ poru, guildId: "g1" });
    const ends = [];
    engine.on("end", (p) => ends.push(p));
    return { poru, player, engine, ends };
}

function track(id) {
    return { encoded: `ENC-${id}`, title: `Track ${id}`, duration_ms: 1000 };
}

test("a natural track end still fires after the previous track was replaced", async () => {
    const { poru, player, engine, ends } = harness();

    await engine.play(track("A"));

    // What Lavalink sends when we load the NEXT track: the old one is replaced.
    poru.emit("trackEnd", player, null, { reason: "replaced" });
    assert.equal(ends.length, 0, "replaced must never be reported as an end");

    await engine.play(track("B"));

    // Track B finishes on its own. The controller must be told, otherwise the
    // queue stalls with `playing` still set.
    poru.emit("queueEnd", player);
    assert.equal(ends.length, 1, "a real end after a replace must be emitted");
    assert.equal(ends[0].reason, "finished");
});

test("replaced and cleanup never count as a track end", async () => {
    const { poru, player, engine, ends } = harness();

    await engine.play(track("A"));
    poru.emit("trackEnd", player, null, { reason: "replaced" });
    poru.emit("trackEnd", player, null, { reason: "cleanup" });

    assert.deepEqual(ends, [], "our own skips must not look like a finished track");
});

test("a second track also reports its own natural end", async () => {
    const { poru, player, engine, ends } = harness();

    for (const id of ["A", "B", "C"]) {
        await engine.play(track(id));
        poru.emit("trackEnd", player, null, { reason: "replaced" });
    }
    poru.emit("queueEnd", player);

    assert.equal(ends.length, 1, "only the final, natural end is reported");
});
