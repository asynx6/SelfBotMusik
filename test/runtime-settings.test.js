"use strict";

const test = require("node:test");
const assert = require("node:assert");

// Mock modules/config so the tests never touch the real SQLite settings.
const cfgPath = require.resolve("../modules/config");
const runtimePath = require.resolve("../modules/runtime");

const BASE = {
    lavaHost: "node.example",
    lavaPort: 443,
    lavaPass: "saved-pass",
    lavaSecure: true,
    guildId: "guild-1",
    channelId: "channel-1",
    chatRequestsEnabled: false,
};

function freshRuntime(initial = BASE) {
    const rt = { ...initial };
    require.cache[cfgPath] = {
        id: cfgPath,
        filename: cfgPath,
        loaded: true,
        exports: {
            loadRuntime: () => rt,
            saveRuntime: (patch) => Object.assign(rt, patch),
        },
    };
    delete require.cache[runtimePath];
    return { mod: require("../modules/runtime"), rt };
}

function makeCtx() {
    const calls = [];
    const stateMod = require("../modules/state");
    stateMod.State.connected = true;
    return {
        calls,
        stopAll: async () => { calls.push("stopAll"); },
        leaveVC: async () => { calls.push("leaveVC"); },
        joinVC: async () => { calls.push("joinVC"); },
        ensurePoru: async () => { calls.push("ensurePoru"); },
        removePoruNode: async () => { calls.push("removePoruNode"); },
        markPoruDirty: () => { calls.push("markPoruDirty"); },
        getPlayer: () => ({}),
        State: { connected: true },
        patch: () => {},
    };
}

test("preference-only save never cycles the node or stops playback", async () => {
    const { mod, rt } = freshRuntime();
    const ctx = makeCtx();
    const r = await mod.applyRuntimeConfig({ chatRequestsEnabled: true }, ctx);
    assert.equal(r.changed, true);
    assert.equal(r.restarted, false);
    assert.equal(rt.chatRequestsEnabled, true);
    assert.deepEqual(ctx.calls, []);
});

test("Lavalink save with unchanged values is a no-op", async () => {
    const { mod } = freshRuntime();
    const ctx = makeCtx();
    const r = await mod.applyRuntimeConfig(
        { lavaHost: BASE.lavaHost, lavaPort: BASE.lavaPort, lavaPass: "", lavaSecure: BASE.lavaSecure },
        ctx
    );
    assert.equal(r.changed, false);
    assert.deepEqual(ctx.calls, []);
});

test("real Lavalink change cycles the node and rejoins voice", async () => {
    const { mod, rt } = freshRuntime();
    const ctx = makeCtx();
    const r = await mod.applyRuntimeConfig({ lavaHost: "new-node.example" }, ctx);
    assert.equal(r.changed, true);
    assert.equal(rt.lavaHost, "new-node.example");
    assert.ok(ctx.calls.includes("stopAll"));
    assert.ok(ctx.calls.includes("markPoruDirty"));
    assert.ok(ctx.calls.includes("ensurePoru"));
    assert.ok(ctx.calls.includes("joinVC"));
});
