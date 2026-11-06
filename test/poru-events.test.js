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

test("nodeDisconnect clears the connected flag", () => {
    const { poru, patches, node } = harness();
    poru.emit("nodeConnect", node);
    poru.emit("nodeDisconnect", node, { code: 1006 });
    assert.equal(patches.at(-1).connected, false);
});

test("nodeError clears the connected flag so the indicator cannot go stale", () => {
    const { poru, patches, node } = harness();
    poru.emit("nodeConnect", node);
    poru.emit("nodeError", node, new Error("ECONNREFUSED 127.0.0.1:2333"));

    const last = patches.at(-1);
    assert.equal(last.connected, false, "a node error must mark Lavalink as offline");
    assert.match(last.lastError, /ECONNREFUSED/);
});
