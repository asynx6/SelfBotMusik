"use strict";

/**
 * Regressions reported after a remote Lavalink node was configured:
 *  - downloaded tracks stopped playing (they were routed to Lavalink)
 *  - chat requests reported success but sent no audio
 *  - the intentional-disconnect flag was never cleared after an engine handoff
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("node:events");

const PlayerController = require("../modules/player-controller");
const { LavalinkEngine } = require("../modules/engines/lavalink");
const { BaseEngine } = require("../modules/engines/base");

class FakeEngine extends BaseEngine {
    constructor(name) {
        super();
        this.name = name;
        this.played = null;
        this.destroyed = false;
    }
    async play(track) { this.played = track; }
    async pause() {}
    async resume() {}
    async stop() {}
    async setVolume() {}
    getPositionMs() { return 0; }
    async destroy() { this.destroyed = true; }
}

function tempLibrary() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbm-offline-"));
    fs.mkdirSync(path.join(dir, "library"), { recursive: true });
    return dir;
}

function mockPoru(resolveImpl) {
    const poru = new EventEmitter();
    poru.players = new Map();
    const player = {
        guildId: "g1",
        queue: [],
        play: async () => {},
        setVolume: async () => {},
        position: 0,
    };
    player.queue.add = function (t) { this.push(t); };
    poru.players.set("g1", player);
    poru.resolve = resolveImpl;
    return { poru, player };
}

class FailingLavalinkEngine extends FakeEngine {
    constructor() { super("lavalink"); }
    async play() { throw new Error("resolve gagal: node remote tidak bisa stream lokal"); }
}

test("a downloaded track falls back to LocalEngine when Lavalink cannot play it", async () => {
    const dir = tempLibrary();
    fs.writeFileSync(path.join(dir, "library", "1.webm"), "audio bytes");

    let local = null;
    const controller = new PlayerController({
        dataDir: dir,
        isLavalinkReady: () => true,
        createLocalEngine: () => (local = new FakeEngine("local")),
        createLavalinkEngine: () => new FailingLavalinkEngine(),
    });

    await controller.enqueue([{ id: 1, title: "Offline", file_path: "1.webm" }]);

    assert.equal(controller.currentEngineType, "local", "a file on disk must still play when Lavalink fails");
    assert.ok(local?.played, "LocalEngine must receive the track");
    assert.equal(controller.currentError, null, "a successful fallback must clear the error banner");

    fs.rmSync(dir, { recursive: true, force: true });
});

test("engine handoff clears the intentional-disconnect flag after playback", async () => {
    const flags = [];
    const controller = new PlayerController({
        isLavalinkReady: () => true,
        onIntentionalDisconnect: (flag) => flags.push(flag),
        createLavalinkEngine: () => new FakeEngine("lavalink"),
    });

    await controller.enqueue([{ title: "Online", uri: "https://example.com/x" }]);

    assert.deepEqual(flags, [true, false], "auto-rejoin must be re-enabled after the handoff completes");
});

test("LavalinkEngine resolves a reference track into a playable encoded track", async () => {
    const { poru, player } = mockPoru(async () => ({
        loadType: "track",
        tracks: [{ track: "ENCODED-BASE64", info: { title: "Resolved" } }],
    }));
    const engine = new LavalinkEngine({ poru, guildId: "g1" });

    await engine.play({
        title: "Requested",
        artist: "Artist",
        uri: "https://www.youtube.com/watch?v=abc",
        source_type: "lavalink",
    });

    assert.equal(player.queue.length, 1);
    assert.equal(player.queue[0].track, "ENCODED-BASE64", "Poru needs a base64 track to call updatePlayer");
});

test("LavalinkEngine fails loudly instead of reporting success with no audio", async () => {
    const { poru } = mockPoru(async () => ({ loadType: "empty", tracks: [] }));
    const engine = new LavalinkEngine({ poru, guildId: "g1" });

    await assert.rejects(
        () => engine.play({ title: "Missing", artist: "Nobody", source_type: "lavalink" }),
        /tidak bisa|encoded|playable/i
    );
});
