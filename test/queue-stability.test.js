"use strict";

/**
 * Queue / voice stability regressions:
 *  - autoplay inserted every recommendation twice
 *  - getSnapshot() exposed every already-played track, so the UI grew forever
 *  - stop() dropped the engine, forcing a leave/rejoin when playback resumed
 *  - engine handoffs on every skip tore down the voice connection
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PlayerController = require("../modules/player-controller");
const { BaseEngine } = require("../modules/engines/base");

class FakeEngine extends BaseEngine {
    constructor(name) {
        super();
        this.name = name;
        this.plays = [];
        this.stopped = 0;
        this.destroyed = 0;
    }
    async play(track) { this.plays.push(track); }
    async pause() {}
    async resume() {}
    async stop() { this.stopped++; }
    async setVolume() {}
    getPositionMs() { return 0; }
    async destroy() { this.destroyed++; }
}

function harness(overrides = {}) {
    const engines = { local: [], lavalink: [] };
    const controller = new PlayerController({
        createLocalEngine: () => {
            const e = new FakeEngine("local");
            engines.local.push(e);
            return e;
        },
        createLavalinkEngine: () => {
            const e = new FakeEngine("lavalink");
            engines.lavalink.push(e);
            return e;
        },
        ...overrides,
    });
    return { controller, engines };
}

const online = (n) => ({ id: n, title: `Online ${n}`, artist: "Artist", uri: `https://example.com/${n}` });

test("skip to an explicit next track does not call autoplay", async () => {
    const { controller, engines } = harness({ isLavalinkReady: () => true });
    let autoplayCalls = 0;
    controller.setAutoplayProvider(() => { autoplayCalls++; return null; });

    await controller.enqueue([online(1), online(2)], "user");
    await controller.next();

    assert.equal(autoplayCalls, 0);
    assert.equal(engines.lavalink[0].plays.length, 2, "same engine, no handoff");
    assert.equal(engines.lavalink[0].destroyed, 0, "voice session must stay alive across skip");
});

test("autoplay adds exactly one track and plays it", async () => {
    const { controller, engines } = harness({ isLavalinkReady: () => true });
    controller.setAutoplayProvider(() => online(99));

    await controller.enqueue([online(1)], "user");
    await controller.next();

    assert.equal(controller.queue.length, 2, "one played + one autoplay, not three");
    assert.equal(controller.currentIndex, 1);
    assert.equal(engines.lavalink[0].plays.at(-1).title, "Online 99");
});

test("stop() keeps the engine so the bot stays in voice", async () => {
    const { controller, engines } = harness({ isLavalinkReady: () => true });
    await controller.enqueue([online(1)], "user");

    await controller.stop();

    assert.notEqual(controller.currentEngine, null, "engine/voice must survive a natural stop");
    assert.equal(engines.lavalink[0].destroyed, 0);
    assert.equal(engines.lavalink[0].stopped, 1);
});

test("getSnapshot exposes only the current and upcoming tracks", async () => {
    const { controller } = harness({ isLavalinkReady: () => true });
    await controller.enqueue([online(1), online(2), online(3)], "user");
    await controller.next();

    const snap = controller.getSnapshot();
    assert.equal(snap.queue.length, 2, "played tracks must not stay in the UI list");
    assert.equal(snap.queue[0].title, "Online 2");
    assert.equal(snap.queue[0].isCurrent, true);
    assert.equal(snap.queue[0].id, 2, "queue items must expose their library id for the download action");
    assert.equal(typeof snap.queue[0].downloaded, "boolean");
    assert.equal(controller.fromUiIndex(1), 2, "UI index 1 maps to internal index 2");
});

test("a Lavalink session is sticky: a downloaded track does not force a handoff", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbm-sticky-"));
    fs.mkdirSync(path.join(dir, "library"), { recursive: true });
    fs.writeFileSync(path.join(dir, "library", "1.webm"), "audio");

    const { controller, engines } = harness({
        dataDir: dir,
        isLavalinkReady: () => true,
    });

    await controller.enqueue([online(1), { id: 2, title: "Offline", file_path: "1.webm" }], "user");
    await controller.next();

    assert.equal(controller.currentEngineType, "lavalink");
    assert.equal(engines.local.length, 0, "no LocalEngine should be created mid-session");
    assert.equal(engines.lavalink[0].destroyed, 0, "no leave/rejoin");

    fs.rmSync(dir, { recursive: true, force: true });
});

test("playNow starts the selection immediately and puts it on top of the queue", async () => {
    const { controller, engines } = harness({ isLavalinkReady: () => true });
    await controller.enqueue([online(1), online(2)], "user");

    await controller.playNow([online(9)], "user");

    const snap = controller.getSnapshot();
    assert.equal(snap.queue[0].title, "Online 9", "selected track becomes the current one");
    assert.equal(snap.queue[1].title, "Online 2", "tracks that were waiting stay behind it");
    assert.equal(engines.lavalink[0].plays.at(-1).title, "Online 9");
    assert.equal(engines.lavalink[0].destroyed, 0, "no voice leave/rejoin");
});

test("playNow with an idle player starts playback directly", async () => {
    const { controller, engines } = harness({ isLavalinkReady: () => true });
    await controller.playNow([online(1)], "user");
    assert.equal(controller.currentIndex, 0);
    assert.equal(engines.lavalink[0].plays.at(-1).title, "Online 1");
});

test("prefetch is requested when the queue is about to run out", async () => {
    const { controller } = harness({ isLavalinkReady: () => true });
    const seeds = [];
    controller.setAutoplayPrefetcher((seed) => { seeds.push(seed); return Promise.resolve(); });

    await controller.enqueue([online(1)], "user");
    await new Promise((r) => setImmediate(r));

    assert.equal(seeds.length, 1);
    assert.equal(seeds[0].title, "Online 1");
});
