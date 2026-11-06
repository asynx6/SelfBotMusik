"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");

const { BaseEngine } = require("../modules/engines/base");
const { PlayerController, serializeTrack, LOOP_MODES } = require("../modules/player-controller");

class MockEngine extends BaseEngine {
    constructor(name = "mock") {
        super();
        this.name = name;
        this.playedTrack = null;
        this.playedOptions = null;
        this.paused = false;
        this.volume = 100;
        this.position = 1234;
        this.destroyed = false;
        this.stopped = false;
    }

    async play(trackRow, options = {}) {
        this.playedTrack = trackRow;
        this.playedOptions = options;
        this.stopped = false;
    }

    async pause() {
        this.paused = true;
    }

    async resume() {
        this.paused = false;
    }

    async stop() {
        this.stopped = true;
    }

    async setVolume(vol) {
        this.volume = vol;
    }

    getPositionMs() {
        return this.position;
    }

    async destroy() {
        this.destroyed = true;
    }
}

function createTempDir() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-test-"));
    const libDir = path.join(tmp, "library");
    fs.mkdirSync(libDir, { recursive: true });
    return tmp;
}

test("1. enqueue local track: one voice owner per session", async () => {
    const tmpDir = createTempDir();
    const localFile = path.join(tmpDir, "library", "1.mp3");
    fs.writeFileSync(localFile, "fake audio");

    let localCreated = 0;
    let localEngine = null;
    let lavalinkCreated = 0;

    const track = {
        id: 1,
        title: "Local Track 1",
        artist: "Artist 1",
        file_path: "1.mp3",
        duration_ms: 180000
    };

    const makeController = (isLavalinkReady) => new PlayerController({
        dataDir: tmpDir,
        isLavalinkReady,
        createLocalEngine: () => {
            localCreated++;
            localEngine = new MockEngine("local");
            return localEngine;
        },
        createLavalinkEngine: () => {
            lavalinkCreated++;
            return new MockEngine("lavalink");
        }
    });

    // Lavalink UP: one engine for the whole session, even for a local file.
    // That avoids destroying/recreating the voice connection on every skip.
    const controller = makeController(() => true);
    const res = await controller.enqueue([track], "user#0001");

    assert.equal(res.queued, false);
    assert.equal(res.playing, true);
    assert.equal(res.queuePosition, 0);
    assert.equal(lavalinkCreated, 1);
    assert.equal(localCreated, 0);
    assert.equal(controller.currentEngineType, "lavalink");
    assert.equal(controller.queue.length, 1);
    assert.equal(controller.currentIndex, 0);

    // Lavalink DOWN: only a file on disk can play, so LocalEngine takes over.
    const offlineController = makeController(() => false);
    await offlineController.enqueue([track], "user#0001");
    assert.equal(localCreated, 1);
    assert.equal(lavalinkCreated, 1);
    assert.equal(offlineController.currentEngineType, "local");
    assert.equal(localEngine.playedTrack.title, "Local Track 1");

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("2. enqueue online track: selects LavalinkEngine and calls play", async () => {
    let lavalinkCreated = 0;
    let lavalinkEngine = null;
    let localCreated = 0;

    const controller = new PlayerController({
        createLocalEngine: () => {
            localCreated++;
            return new MockEngine("local");
        },
        createLavalinkEngine: () => {
            lavalinkCreated++;
            lavalinkEngine = new MockEngine("lavalink");
            return lavalinkEngine;
        }
    });

    const onlineTrack = {
        title: "Online Stream",
        artist: "Online Artist",
        uri: "https://www.youtube.com/watch?v=online123",
        source_type: "lavalink",
        duration_ms: 240000
    };

    const res = await controller.enqueue([onlineTrack], "listener#1234");

    assert.equal(res.queued, false);
    assert.equal(res.playing, true);
    assert.equal(lavalinkCreated, 1);
    assert.equal(localCreated, 0);
    assert.equal(controller.currentEngineType, "lavalink");
    assert.equal(lavalinkEngine.playedTrack.title, "Online Stream");
});

test("3. Handoff with Lavalink down: local track on LocalEngine, then Lavalink comes up -> handoff to LavalinkEngine", async () => {
    const tmpDir = createTempDir();
    const localFile = path.join(tmpDir, "library", "local1.mp3");
    fs.writeFileSync(localFile, "local audio bytes");

    let intentionalDisconnectCalls = [];
    let localEngine = null;
    let lavalinkEngine = null;
    let lavalinkUp = false;

    const controller = new PlayerController({
        dataDir: tmpDir,
        isLavalinkReady: () => lavalinkUp,
        onIntentionalDisconnect: (flag) => {
            intentionalDisconnectCalls.push(flag);
        },
        createLocalEngine: () => {
            localEngine = new MockEngine("local");
            return localEngine;
        },
        createLavalinkEngine: () => {
            lavalinkEngine = new MockEngine("lavalink");
            return lavalinkEngine;
        }
    });

    const localTrack = { title: "Song 1 Local", file_path: "local1.mp3" };
    const onlineTrack = { title: "Song 2 Lavalink", uri: "https://yt.com/watch?v=2" };

    // Lavalink is down: local track plays on LocalEngine
    await controller.enqueue([localTrack, onlineTrack], "dj#0001");

    assert.equal(controller.currentEngineType, "local");
    assert.equal(localEngine.playedTrack.title, "Song 1 Local");
    assert.equal(localEngine.destroyed, false);

    // Lavalink becomes available, then advance to song 2
    lavalinkUp = true;
    await controller.next();

    assert.equal(localEngine.destroyed, true, "LocalEngine should be destroyed during handoff");
    assert(intentionalDisconnectCalls.includes(true), "onIntentionalDisconnect(true) should be flagged");
    assert.equal(controller.currentEngineType, "lavalink");
    assert.equal(lavalinkEngine.playedTrack.title, "Song 2 Lavalink");

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("4. Track without file and lavalink unavailable/failed: skip automatically with lastError and audit log", async () => {
    const auditLogs = [];
    const mockDb = {
        prepare: (sql) => ({
            run: (...args) => {
                auditLogs.push({ sql, args });
            }
        })
    };

    const controller = new PlayerController({
        db: mockDb,
        isLavalinkReady: () => false, // Lavalink disconnected
        createLavalinkEngine: () => null,
        createLocalEngine: () => new MockEngine("local")
    });

    const track1 = { title: "Offline Stream", uri: "https://example.com/stream" };
    await controller.enqueue([track1], "user1");

    assert(controller.lastError !== null, "lastError should be recorded");
    assert.equal(controller.currentIndex, -1, "Queue should end because the only track was skipped");
    assert(auditLogs.some(log => log.args.includes("track_skip") || log.args.includes("track_error")));
});

test("5. Loop mode OFF (0): last track end stops engine and clears queue", async () => {
    let lavalinkEngine = null;
    const controller = new PlayerController({
        createLavalinkEngine: () => {
            lavalinkEngine = new MockEngine("lavalink");
            return lavalinkEngine;
        }
    });

    controller.setLoop(0); // OFF

    const track = { title: "Only Song", uri: "https://yt.com/1" };
    await controller.enqueue([track], "user");

    assert.equal(controller.currentIndex, 0);
    assert.equal(controller.queue.length, 1);

    // Track finishes
    lavalinkEngine.emit("end", { reason: "finished" });
    // Allow async handlers to settle
    await new Promise((r) => setImmediate(r));

    assert.equal(controller.currentIndex, -1);
    assert.equal(controller.queue.length, 0);
    assert.equal(lavalinkEngine.stopped, true);
});

test("6. Loop mode TRACK (1): track end replays same track at same index", async () => {
    let lavalinkEngine = null;
    const controller = new PlayerController({
        createLavalinkEngine: () => {
            lavalinkEngine = new MockEngine("lavalink");
            return lavalinkEngine;
        }
    });

    controller.setLoop(1); // TRACK

    const track1 = { title: "Song 1", uri: "https://yt.com/1" };
    const track2 = { title: "Song 2", uri: "https://yt.com/2" };
    await controller.enqueue([track1, track2], "user");

    assert.equal(controller.currentIndex, 0);

    // Track 1 ends
    lavalinkEngine.emit("end", { reason: "finished" });
    await new Promise((r) => setImmediate(r));

    assert.equal(controller.currentIndex, 0, "Current index should stay 0 in TRACK loop mode");
    assert.equal(lavalinkEngine.playedTrack.title, "Song 1");
});

test("7. Loop mode QUEUE (2): track end at end of queue wraps to index 0", async () => {
    let lavalinkEngine = null;
    const controller = new PlayerController({
        createLavalinkEngine: () => {
            lavalinkEngine = new MockEngine("lavalink");
            return lavalinkEngine;
        }
    });

    controller.setLoop(2); // QUEUE

    const track1 = { title: "Song 1", uri: "https://yt.com/1" };
    const track2 = { title: "Song 2", uri: "https://yt.com/2" };
    await controller.enqueue([track1, track2], "user");

    // Advance to track 2
    await controller.jumpTo(1);
    assert.equal(controller.currentIndex, 1);
    assert.equal(lavalinkEngine.playedTrack.title, "Song 2");

    // Track 2 ends
    lavalinkEngine.emit("end", { reason: "finished" });
    await new Promise((r) => setImmediate(r));

    assert.equal(controller.currentIndex, 0, "Loop QUEUE should wrap to 0 after last song");
    assert.equal(lavalinkEngine.playedTrack.title, "Song 1");
});

test("8. removeAt & clearQueue modify queue correctly", async () => {
    let lavalinkEngine = null;
    const controller = new PlayerController({
        createLavalinkEngine: () => {
            lavalinkEngine = new MockEngine("lavalink");
            return lavalinkEngine;
        }
    });

    const t1 = { title: "Track 1", uri: "https://yt.com/1" };
    const t2 = { title: "Track 2", uri: "https://yt.com/2" };
    const t3 = { title: "Track 3", uri: "https://yt.com/3" };
    const t4 = { title: "Track 4", uri: "https://yt.com/4" };

    await controller.enqueue([t1, t2, t3, t4], "user");
    assert.equal(controller.queue.length, 4);
    assert.equal(controller.currentIndex, 0);

    // removeAt(0) must throw
    assert.throws(() => controller.removeAt(0), /Cannot remove currently playing track/);

    // removeAt(invalid index) must throw
    assert.throws(() => controller.removeAt(99), /Index out of range/);

    // removeAt(2) removes Track 3
    const removedRes = controller.removeAt(2);
    assert.equal(removedRes.removed, 1);
    assert.equal(controller.queue.length, 3);
    assert.equal(controller.queue[0].track.title, "Track 1");
    assert.equal(controller.queue[1].track.title, "Track 2");
    assert.equal(controller.queue[2].track.title, "Track 4");

    // clearQueue() keeps current playing track and clears remaining
    const clearRes = controller.clearQueue();
    assert.equal(clearRes.cleared, 2);
    assert.equal(controller.queue.length, 1);
    assert.equal(controller.queue[0].track.title, "Track 1");
    assert.equal(controller.currentIndex, 0);
});

test("9. getSnapshot produces format 100% compatible with State contract", async () => {
    let mockEng = null;
    const controller = new PlayerController({
        createLavalinkEngine: () => {
            mockEng = new MockEngine("lavalink");
            mockEng.position = 45000;
            return mockEng;
        }
    });

    controller.setVolume(85);
    controller.setLoop(1);

    const track1 = {
        title: "Song Alpha",
        artist: "Artist Alpha",
        duration_ms: 200000,
        uri: "https://youtube.com/watch?v=alpha",
        identifier: "alpha123"
    };
    const track2 = {
        title: "Song Beta",
        artist: "Artist Beta",
        duration_ms: 150000,
        uri: "https://youtube.com/watch?v=beta"
    };

    await controller.enqueue([track1, track2], "tester#1111");

    const snap = controller.getSnapshot();

    assert.equal(snap.paused, false);
    assert.equal(snap.volume, 85);
    assert.equal(snap.loop, 1);
    assert.equal(snap.position, 45000);

    assert(snap.playing !== null, "playing should be populated");
    assert.equal(snap.playing.title, "Song Alpha");
    assert.equal(snap.playing.author, "Artist Alpha");
    assert.equal(snap.playing.duration, 200000);
    assert.equal(snap.playing.uri, "https://youtube.com/watch?v=alpha");
    assert.equal(snap.playing.thumbnail, "https://i.ytimg.com/vi/alpha123/hqdefault.jpg");
    assert.equal(snap.playing.requester, "tester#1111");
    assert.equal(snap.playing.isCurrent, true);

    assert.equal(snap.queue.length, 2);
    assert.equal(snap.queue[0].isCurrent, true);
    assert.equal(snap.queue[1].isCurrent, false);
    assert.equal(snap.queue[1].title, "Song Beta");
});

test("10. pause, resume, togglePause, setVolume, cycleLoop, and jumpTo delegate correctly", async () => {
    let mockEng = null;
    const controller = new PlayerController({
        createLavalinkEngine: () => {
            mockEng = new MockEngine("lavalink");
            return mockEng;
        }
    });

    const t1 = { title: "T1", uri: "https://yt.com/1" };
    const t2 = { title: "T2", uri: "https://yt.com/2" };
    await controller.enqueue([t1, t2], "user");

    // Pause
    await controller.pause();
    assert.equal(controller.paused, true);
    assert.equal(mockEng.paused, true);

    // Resume
    await controller.resume();
    assert.equal(controller.paused, false);
    assert.equal(mockEng.paused, false);

    // Toggle pause
    await controller.togglePause();
    assert.equal(controller.paused, true);
    await controller.togglePause();
    assert.equal(controller.paused, false);

    // Set volume clamps 0..200
    await controller.setVolume(150);
    assert.equal(controller.volume, 150);
    assert.equal(mockEng.volume, 150);

    await controller.setVolume(300);
    assert.equal(controller.volume, 200);

    await controller.setVolume(-50);
    assert.equal(controller.volume, 0);

    // Cycle loop: 0 -> 1 -> 2 -> 0
    controller.setLoop(0);
    controller.cycleLoop();
    assert.equal(controller.loop, 1);
    controller.cycleLoop();
    assert.equal(controller.loop, 2);
    controller.cycleLoop();
    assert.equal(controller.loop, 0);

    // jumpTo(1)
    await controller.jumpTo(1);
    assert.equal(controller.currentIndex, 1);
    assert.equal(mockEng.playedTrack.title, "T2");

    // jumpTo invalid
    await assert.rejects(() => controller.jumpTo(-1), /Index out of range/);
    await assert.rejects(() => controller.jumpTo(10), /Index out of range/);
});

test("11. playCurrent updates play_count and last_played_at in database", async () => {
    const dbUpdates = [];
    const mockDb = {
        prepare: (sql) => ({
            run: (...args) => {
                dbUpdates.push({ sql, args });
            }
        })
    };

    const controller = new PlayerController({
        db: mockDb,
        createLavalinkEngine: () => new MockEngine("lavalink")
    });

    const track = { id: 42, title: "DB Track", uri: "https://yt.com/db" };
    await controller.enqueue([track], "user");

    const playCountUpdate = dbUpdates.find((u) => u.sql.includes("UPDATE tracks SET play_count = play_count + 1"));
    assert(playCountUpdate, "play_count update should be issued");
    assert.equal(playCountUpdate.args[1], 42); // track.id

    const historyInsert = dbUpdates.find((u) => u.sql.includes("INSERT INTO history"));
    assert(historyInsert, "history row should be recorded");
    assert.equal(historyInsert.args[0], 42); // track.id
});

test("12. TRACK loop with unplayable track: skips forward instead of infinite loop", async () => {
    const tmpDir = createTempDir();

    // Engine that refuses one specific track, like a dead source.
    class PickyEngine extends MockEngine {
        async play(trackRow, options = {}) {
            if (trackRow.title === "Broken") throw new Error("source unavailable");
            return super.play(trackRow, options);
        }
    }

    let lavalinkEngine = null;
    const controller = new PlayerController({
        dataDir: tmpDir,
        createLavalinkEngine: () => {
            lavalinkEngine = new PickyEngine("lavalink");
            return lavalinkEngine;
        }
    });

    controller.setLoop(1); // TRACK

    const unplayable = { title: "Broken", uri: "https://yt.com/broken" };
    const ok = { title: "Good Song", uri: "https://yt.com/good" };
    await controller.enqueue([unplayable, ok], "user");

    assert.equal(controller.currentIndex, 1, "Unplayable track should be skipped forward even in TRACK loop");
    assert.equal(lavalinkEngine.playedTrack.title, "Good Song");

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("13. removeAt(0) is legal when track 0 is not currently playing", async () => {
    let lavalinkEngine = null;
    const controller = new PlayerController({
        createLavalinkEngine: () => {
            lavalinkEngine = new MockEngine("lavalink");
            return lavalinkEngine;
        }
    });

    const t1 = { title: "T1", uri: "https://yt.com/1" };
    const t2 = { title: "T2", uri: "https://yt.com/2" };
    const t3 = { title: "T3", uri: "https://yt.com/3" };
    await controller.enqueue([t1, t2, t3], "user");

    await controller.jumpTo(2);
    assert.equal(controller.currentIndex, 2);

    controller.removeAt(0);
    assert.equal(controller.queue.length, 2);
    assert.equal(controller.queue[0].track.title, "T2");
    assert.equal(controller.currentIndex, 1, "Current index shifts down when an earlier track is removed");
    assert.equal(lavalinkEngine.playedTrack.title, "T3");
});

test("14. TRACK loop with track erroring mid-playback: skips forward instead of replaying same track", async () => {
    let lavalinkEngine = null;
    const controller = new PlayerController({
        createLavalinkEngine: () => {
            lavalinkEngine = new MockEngine("lavalink");
            return lavalinkEngine;
        }
    });

    controller.setLoop(1); // TRACK

    const bad = { title: "Bad Song", uri: "https://yt.com/bad" };
    const good = { title: "Good Song", uri: "https://yt.com/good" };
    await controller.enqueue([bad, good], "user");

    assert.equal(controller.currentIndex, 0);
    assert.equal(lavalinkEngine.playedTrack.title, "Bad Song");

    // Track errors mid-playback
    lavalinkEngine.emit("error", new Error("playback failed"));
    await new Promise((r) => setImmediate(r));

    assert.equal(controller.currentIndex, 1, "Errored track should be skipped forward even in TRACK loop");
    assert.equal(lavalinkEngine.playedTrack.title, "Good Song");
    assert(controller.lastError !== null, "lastError should be set");
});

test("15. QUEUE loop + single unplayable track: stops cleanly instead of infinite recursion", async () => {
    const controller = new PlayerController({
        isLavalinkReady: () => false,
        createLavalinkEngine: () => null,
        createLocalEngine: () => new MockEngine("local")
    });

    controller.setLoop(2); // QUEUE

    const unplayable = { title: "Broken Only Track", uri: "https://yt.com/broken" };
    await controller.enqueue([unplayable], "user");

    assert.equal(controller.currentIndex, -1, "Should stop cleanly");
    assert.equal(controller.queue.length, 0);
    assert(controller.lastError !== null, "lastError should record the skip");
});

test("17. stop() keeps the voice session: only disconnect() destroys the engine", async () => {
    let lavalinkCreated = 0;
    let lavalinkEngine = null;

    const controller = new PlayerController({
        createLavalinkEngine: () => {
            lavalinkCreated++;
            lavalinkEngine = new MockEngine("lavalink");
            return lavalinkEngine;
        }
    });

    await controller.enqueue([{ title: "T1", uri: "https://yt.com/1" }], "user");
    assert.equal(lavalinkCreated, 1);

    await controller.stop();
    assert.notEqual(controller.currentEngine, null, "a natural stop must keep the bot in voice");
    assert.equal(lavalinkEngine.stopped, true);

    // A new track reuses the same engine/voice session — no leave + rejoin.
    await controller.enqueue([{ title: "T2", uri: "https://yt.com/2" }], "user");
    assert.equal(lavalinkCreated, 1, "no new engine/voice connection after a natural stop");
    assert.equal(lavalinkEngine.playedTrack.title, "T2", "Playback should work after stop");

    // The Stop button goes through disconnect(), which is the only path that
    // tears down the voice connection.
    await controller.disconnect();
    assert.equal(controller.currentEngine, null);
    assert.equal(lavalinkEngine.destroyed, true);
});

test("16. Lavalink down mid-queue: local handoff works; Lavalink returns -> handoff back with factory re-run", async () => {
    const tmpDir = createTempDir();
    const localFile = path.join(tmpDir, "library", "mid.mp3");
    fs.writeFileSync(localFile, "local audio bytes");

    let lavalinkCreated = 0;
    let lavalinkEngine = null;
    let localEngine = null;
    let lavalinkUp = true;

    const controller = new PlayerController({
        dataDir: tmpDir,
        isLavalinkReady: () => lavalinkUp,
        // Simulates index.js: LavalinkEngine.destroy() kills the Poru player,
        // so the factory must recreate it before returning a new engine.
        createLavalinkEngine: async () => {
            lavalinkCreated++;
            lavalinkEngine = new MockEngine("lavalink");
            return lavalinkEngine;
        },
        createLocalEngine: () => {
            localEngine = new MockEngine("local");
            return localEngine;
        }
    });

    const t1 = { title: "Lava 1", uri: "https://yt.com/1" };
    const t2 = { title: "Local Mid", file_path: "mid.mp3" };
    const t3 = { title: "Lava 3", uri: "https://yt.com/3" };
    await controller.enqueue([t1, t2, t3], "user");

    assert.equal(lavalinkCreated, 1);
    assert.equal(lavalinkEngine.playedTrack.title, "Lava 1");

    // Lavalink goes down; the local track takes over on LocalEngine
    lavalinkUp = false;
    lavalinkEngine.emit("end", { reason: "finished" });
    await new Promise((r) => setImmediate(r));
    assert.equal(controller.currentEngineType, "local");
    assert.equal(localEngine.playedTrack.title, "Local Mid");

    // Lavalink returns: handoff back, factory must be called again (player recreated)
    lavalinkUp = true;
    localEngine.emit("end", { reason: "finished" });
    await new Promise((r) => setImmediate(r));

    assert.equal(lavalinkCreated, 2, "Lavalink factory must re-run after destroy");
    assert.equal(controller.currentEngineType, "lavalink");
    assert.equal(lavalinkEngine.playedTrack.title, "Lava 3", "Second lavalink track should play, not be skipped");

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("18. played tracks are compacted so the queue cannot grow for the whole uptime", async () => {
    const tmpDir = createTempDir();
    const controller = new PlayerController({
        dataDir: tmpDir,
        createLavalinkEngine: () => new MockEngine("lavalink"),
    });

    const tracks = Array.from({ length: 200 }, (_, i) => ({
        id: i + 1,
        title: `Track ${i}`,
        source_type: "lavalink",
        uri: `https://example.com/${i}`,
    }));

    await controller.enqueue(tracks);
    assert.equal(controller.queue.length, 200);

    for (let i = 0; i < 150; i += 1) {
        await controller.next();
    }

    // 150 of 200 tracks have been consumed; the array must have shed them
    // instead of holding every track ever played.
    assert.ok(
        controller.queue.length < 100,
        `queue should shrink after playback, got ${controller.queue.length}`
    );

    // Compaction must not shift the wrong track into the current slot.
    const playing = controller.queue[controller.currentIndex];
    assert.ok(playing, "currentIndex must still point at a valid entry");
    assert.equal(playing.track.id, tracks[150].id, "the 151st track must be the one playing");

    await controller.stop();
    assert.equal(controller.queue.length, 0, "stop() still clears everything");

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Voice session ownership -------------------------------------------------
// Offline (local) playback connects to voice through the LocalEngine, not
// through Poru. So "disconnect" only works if the controller DESTROYS the
// active engine — `stop()` alone silences playback but leaves the bot sitting
// in the voice channel.

test("19. disconnect() destroys the active engine so the bot leaves the voice channel", async () => {
    const controller = new PlayerController({
        createLavalinkEngine: () => new MockEngine("lavalink"),
        isLavalinkReady: () => true,
    });

    await controller.enqueue([{ id: 91, title: "Offline Song", uri: "u", encoded: "e" }], "user");
    const engine = controller.currentEngine;
    assert.ok(engine, "an engine should be live after enqueue");
    assert.equal(engine.destroyed, false, "engine starts alive");

    await controller.disconnect();

    assert.equal(engine.destroyed, true, "disconnect must destroy the engine (it owns the voice connection)");
    assert.equal(controller.currentEngine, null, "engine reference must be dropped");
    assert.equal(controller.currentEngineType, null);
    assert.equal(controller.queue.length, 0, "queue must be cleared");
    assert.equal(controller.currentIndex, -1);
    assert.equal(controller.paused, false);
});

test("20. stop() alone does NOT destroy the engine (voice session stays open)", async () => {
    const controller = new PlayerController({
        createLavalinkEngine: () => new MockEngine("lavalink"),
        isLavalinkReady: () => true,
    });

    await controller.enqueue([{ id: 92, title: "Song", uri: "u", encoded: "e" }], "user");
    const engine = controller.currentEngine;

    await controller.stop();

    assert.equal(engine.destroyed, false, "stop() must not tear down the voice connection");
    assert.equal(engine.stopped, true, "stop() still stops playback");
});

test("21. an online track with no Lavalink node is skipped with an actionable error", async () => {
    const controller = new PlayerController({
        isLavalinkReady: () => false,
        createLavalinkEngine: () => { throw new Error("Lavalink not configured"); },
    });

    await controller.enqueue([{ id: 93, title: "Online Song", uri: "https://yt.com/x" }], "user");

    assert.ok(controller.lastError, "the failure must be recorded");
    assert.match(
        controller.lastError.message,
        /Lavalink/i,
        "the error should tell the user Lavalink is the missing piece"
    );
});
