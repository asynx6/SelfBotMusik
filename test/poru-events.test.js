"use strict";

/**
 * The dashboard's Lavalink indicator reads State.connected, which is patched
 * from Poru events. If nodeError forgets to clear it, a dead node is reported
 * as "connected" until a nodeDisconnect happens to arrive.
 */

const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { wirePoruEvents } = require("../modules/poru-manager");

function harness() {
    const poru = new EventEmitter();
    const patches = [];
    wirePoruEvents(poru, (patch) => patches.push(patch));
    return { poru, patches, node: { name: "main" } };
}

test("nodeConnect reports a live node", () => {
    const { poru, patches, node } = harness();
    poru.emit("nodeConnect", node);
    assert.deepEqual(patches, [{ connected: true, lastError: null }]);
});

test("nodeDisconnect clears the connected flag only after the offline grace period", async () => {
    const { poru, patches, node } = harness();
    poru.emit("nodeConnect", node);
    const before = patches.length;
    poru.emit("nodeDisconnect", node, 1006);

    // A momentary drop must not strobe the indicator — the node reconnects in
    // about a second, and `nodeConnect` cancels the pending offline patch.
    assert.equal(patches.length, before, "no immediate offline patch");

    await new Promise((r) => setTimeout(r, 5100));
    assert.equal(patches.at(-1).connected, false, "still down after the grace period → offline");
});

test("a reconnect inside the grace period cancels the offline patch", async () => {
    const { poru, patches, node } = harness();
    poru.emit("nodeConnect", node);
    poru.emit("nodeDisconnect", node, 1006);
    poru.emit("nodeConnect", node);

    await new Promise((r) => setTimeout(r, 5100));
    assert.equal(patches.at(-1).connected, true, "the blip never surfaced as offline");
});

test("nodeError records the message but does NOT flap the connected flag", () => {
    const { poru, patches, node } = harness();
    poru.emit("nodeConnect", node);
    poru.emit("nodeError", node, new Error("ECONNREFUSED 127.0.0.1:2333"));

    const last = patches.at(-1);
    assert.equal(last.connected, undefined, "a transient error must not mark Lavalink offline — only nodeDisconnect does");
    assert.match(last.lastError, /ECONNREFUSED/);
});
