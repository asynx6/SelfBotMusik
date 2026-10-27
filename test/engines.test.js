"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const { BaseEngine } = require("../modules/engines/base");
const { LavalinkEngine } = require("../modules/engines/lavalink");
const { LocalEngine } = require("../modules/engines/local");
const { AudioPlayerStatus } = require("@discordjs/voice");

test("BaseEngine contract: implements all interface methods and extends EventEmitter", async () => {
    const engine = new BaseEngine();
    assert.equal(engine.name, "base");
    assert(engine instanceof EventEmitter, "BaseEngine should extend EventEmitter");

    await assert.rejects(() => engine.play({}), /not implemented/);
    await assert.rejects(() => engine.pause(), /not implemented/);
    await assert.rejects(() => engine.resume(), /not implemented/);
    await assert.rejects(() => engine.stop(), /not implemented/);
    await assert.rejects(() => engine.setVolume(100), /not implemented/);
    assert.throws(() => engine.getPositionMs(), /not implemented/);
    await assert.rejects(() => engine.destroy(), /not implemented/);

    let emittedEnd = false;
    engine.on("end", (evt) => {
        emittedEnd = true;
        assert.equal(evt.reason, "finished");
    });
    engine.emit("end", { reason: "finished" });
    assert.equal(emittedEnd, true);
});

test("LavalinkEngine: rejects local tracks and non-lavalink sources", async () => {
    const mockPoru = new EventEmitter();
    mockPoru.players = new Map();
    const engine = new LavalinkEngine({ poru: mockPoru, guildId: "g1" });
    assert.equal(engine.name, "lavalink");

    await assert.rejects(
        () => engine.play({ file_path: "track.mp3", source_type: "local" }),
        /Local tracks not supported/
    );

    await assert.rejects(
        () => engine.play({ source_type: "spotify", uri: "https://example.com" }),
        /requires source_type === 'lavalink'/
    );

    await assert.rejects(
        () => engine.play({ source_type: "lavalink", uri: "https://example.com" }),
        /No Poru player found for guild g1/
    );
});

test("LavalinkEngine: play delegates to Poru player and wires trackEnd/trackError/trackStuck events", async () => {
    const mockPoru = new EventEmitter();
    mockPoru.players = new Map();

    let playCalled = false;
    let volumeCalledWith = null;
    let seekCalledWith = null;

    const mockPlayer = new EventEmitter();
    mockPlayer.guildId = "g1";
    mockPlayer.queue = [];
    mockPlayer.queue.add = function (t) { this.push(t); };
    mockPlayer.play = async () => { playCalled = true; };
    mockPlayer.setVolume = async (v) => { volumeCalledWith = v; };
    mockPlayer.seekTo = async (pos) => { seekCalledWith = pos; };
    mockPlayer.position = 4500;

    mockPoru.players.set("g1", mockPlayer);

    const engine = new LavalinkEngine({ poru: mockPoru, guildId: "g1" });

    let endEmitted = null;
    let errorEmitted = null;
    let stuckEmitted = null;

    engine.on("end", (e) => { endEmitted = e; });
    engine.on("error", (e) => { errorEmitted = e; });
    engine.on("stuck", (e) => { stuckEmitted = e; });

    const trackRow = {
        title: "Test Song",
        artist: "Test Artist",
        duration_ms: 180000,
        uri: "https://youtube.com/watch?v=123",
        encoded: "encoded-track-data",
        source_type: "lavalink"
    };

    await engine.play(trackRow, { volume: 80, startMs: 5000 });

    assert.equal(playCalled, true);
    assert.equal(volumeCalledWith, 80);
    assert.equal(seekCalledWith, 5000);
    assert.equal(mockPlayer.queue.length, 1);
    assert.equal(mockPlayer.queue[0].track, "encoded-track-data");
    assert.equal(mockPlayer.queue[0].info.title, "Test Song");

    // Test trackEnd event via poru
    mockPoru.emit("trackEnd", mockPlayer, mockPlayer.queue[0], { reason: "finished" });
    assert.deepEqual(endEmitted, { reason: "finished" });

    // Test trackError event via poru
    mockPoru.emit("trackError", mockPlayer, mockPlayer.queue[0], { exception: new Error("Poru track error") });
    assert(errorEmitted instanceof Error);
    assert.equal(errorEmitted.message, "Poru track error");

    // Test trackStuck event via poru
    mockPoru.emit("trackStuck", mockPlayer, mockPlayer.queue[0], 12000);
    assert.equal(stuckEmitted.thresholdMs, 12000);
});

test("LavalinkEngine: pause, resume, stop, setVolume, getPositionMs delegate to player", async () => {
    const mockPoru = new EventEmitter();
    mockPoru.players = new Map();

    let pauseCalled = false;
    let resumeCalled = false;
    let stopCalled = false;
    let volumeCalled = null;

    const mockPlayer = new EventEmitter();
    mockPlayer.guildId = "g1";
    mockPlayer.pause = async (flag) => {
        if (flag) pauseCalled = true;
        else resumeCalled = true;
    };
    mockPlayer.stop = async () => { stopCalled = true; };
    mockPlayer.setVolume = async (v) => { volumeCalled = v; };
    mockPlayer.position = 7890;

    mockPoru.players.set("g1", mockPlayer);

    const engine = new LavalinkEngine({ poru: mockPoru, guildId: "g1" });

    await engine.pause();
    assert.equal(pauseCalled, true);

    await engine.resume();
    assert.equal(resumeCalled, true);

    await engine.setVolume(120);
    assert.equal(volumeCalled, 120);

    assert.equal(engine.getPositionMs(), 7890);

    await engine.stop();
    assert.equal(stopCalled, true);
});

test("LavalinkEngine: destroy cleans queue, stops player, and removes listeners", async () => {
    const mockPoru = new EventEmitter();
    mockPoru.players = new Map();

    let stopCalled = false;
    let destroyCalled = false;

    const mockPlayer = new EventEmitter();
    mockPlayer.guildId = "g1";
    mockPlayer.queue = ["track1", "track2"];
    mockPlayer.stop = async () => { stopCalled = true; };
    mockPlayer.destroy = async () => { destroyCalled = true; };

    mockPoru.players.set("g1", mockPlayer);

    const engine = new LavalinkEngine({ poru: mockPoru, guildId: "g1" });
    await engine.play({ title: "Track", source_type: "lavalink", uri: "http://example.com" });

    let endCallCount = 0;
    engine.on("end", () => { endCallCount++; });

    await engine.destroy();

    assert.equal(mockPlayer.queue.length, 0);
    assert.equal(stopCalled, true);
    assert.equal(destroyCalled, true);

    // Emitting on mockPoru should not reach engine after destroy
    mockPoru.emit("trackEnd", mockPlayer, null, { reason: "finished" });
    assert.equal(endCallCount, 0);
});

test("LocalEngine: play validates file exists and spawns ffmpeg with correct arguments", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbm-local-engine-"));
    const libraryDir = path.join(tmpDir, "library");
    fs.mkdirSync(libraryDir, { recursive: true });

    const trackFileName = "123.mp3";
    const fullAudioPath = path.join(libraryDir, trackFileName);
    fs.writeFileSync(fullAudioPath, Buffer.from("dummy audio content"));

    let spawnArgs = null;
    let spawnOptions = null;
    let spawnedStdout = null;

    const mockFfmpeg = new EventEmitter();
    mockFfmpeg.stdout = new PassThrough();
    mockFfmpeg.kill = () => {};

    const mockSpawn = (cmd, args, opts) => {
        spawnArgs = { cmd, args };
        spawnOptions = opts;
        spawnedStdout = mockFfmpeg.stdout;
        return mockFfmpeg;
    };

    let subscribedPlayer = null;
    const mockVoiceConnection = {
        subscribe: (p) => { subscribedPlayer = p; },
        destroy: () => {}
    };

    let playedResource = null;
    const mockAudioPlayer = new EventEmitter();
    mockAudioPlayer.play = (res) => { playedResource = res; };
    mockAudioPlayer.pause = () => {};
    mockAudioPlayer.unpause = () => {};
    mockAudioPlayer.stop = () => {};

    const engine = new LocalEngine({
        guildId: "g1",
        channelId: "c1",
        ffmpegPath: "custom-ffmpeg",
        dataDir: tmpDir,
        voiceConnection: mockVoiceConnection,
        audioPlayer: mockAudioPlayer,
        spawn: mockSpawn
    });
    assert.equal(engine.name, "local");

    // Missing file_path throws
    await assert.rejects(() => engine.play({}), /Local track missing file_path/);

    // Non-existent file throws
    await assert.rejects(
        () => engine.play({ file_path: "missing.mp3" }),
        /Physical audio file does not exist/
    );

    // Valid play with volume
    await engine.play({ file_path: trackFileName }, { volume: 150 });

    assert.equal(spawnArgs.cmd, "custom-ffmpeg");
    assert.deepEqual(spawnArgs.args, [
        "-i", fullAudioPath,
        "-f", "s16le",
        "-ar", "48000",
        "-ac", "2",
        "pipe:1"
    ]);
    assert.deepEqual(spawnOptions.stdio, ["ignore", "pipe", "inherit"]);
    assert.equal(subscribedPlayer, mockAudioPlayer);
    assert(playedResource !== null, "Resource should be passed to audioPlayer.play");

    // Play with startMs prepends -ss
    await engine.play({ file_path: trackFileName }, { volume: 100, startMs: 12500 });
    assert.deepEqual(spawnArgs.args, [
        "-ss", "12.5",
        "-i", fullAudioPath,
        "-f", "s16le",
        "-ar", "48000",
        "-ac", "2",
        "pipe:1"
    ]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("LocalEngine: pause, resume, setVolume, getPositionMs delegate properly", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbm-local-engine2-"));
    const libraryDir = path.join(tmpDir, "library");
    fs.mkdirSync(libraryDir, { recursive: true });
    fs.writeFileSync(path.join(libraryDir, "song.mp3"), Buffer.from("data"));

    let pauseCalled = false;
    let unpauseCalled = false;

    const mockAudioPlayer = new EventEmitter();
    mockAudioPlayer.play = () => {};
    mockAudioPlayer.pause = () => { pauseCalled = true; };
    mockAudioPlayer.unpause = () => { unpauseCalled = true; };
    mockAudioPlayer.stop = () => {};
    mockAudioPlayer.state = {
        resource: {
            playbackDuration: 3450
        }
    };

    const mockFfmpeg = new EventEmitter();
    mockFfmpeg.stdout = new PassThrough();
    mockFfmpeg.kill = () => {};

    const engine = new LocalEngine({
        guildId: "g1",
        channelId: "c1",
        dataDir: tmpDir,
        audioPlayer: mockAudioPlayer,
        spawn: () => mockFfmpeg
    });

    await engine.play({ file_path: "song.mp3" }, { volume: 100 });

    await engine.pause();
    assert.equal(pauseCalled, true);

    await engine.resume();
    assert.equal(unpauseCalled, true);

    await engine.setVolume(75);
    assert.equal(engine.volume, 75);

    assert.equal(engine.getPositionMs(), 3450);

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("LocalEngine: stop and destroy kill ffmpeg and destroy voice connection", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbm-local-engine3-"));
    const libraryDir = path.join(tmpDir, "library");
    fs.mkdirSync(libraryDir, { recursive: true });
    fs.writeFileSync(path.join(libraryDir, "song.mp3"), Buffer.from("data"));

    let ffmpegKilled = false;
    const mockFfmpeg = new EventEmitter();
    mockFfmpeg.stdout = new PassThrough();
    mockFfmpeg.kill = () => { ffmpegKilled = true; };

    let playerStopped = false;
    const mockAudioPlayer = new EventEmitter();
    mockAudioPlayer.play = () => {};
    mockAudioPlayer.stop = () => { playerStopped = true; };

    let connectionDestroyed = false;
    const mockVoiceConnection = {
        subscribe: () => {},
        destroy: () => { connectionDestroyed = true; }
    };

    const engine = new LocalEngine({
        guildId: "g1",
        channelId: "c1",
        dataDir: tmpDir,
        voiceConnection: mockVoiceConnection,
        audioPlayer: mockAudioPlayer,
        spawn: () => mockFfmpeg
    });

    await engine.play({ file_path: "song.mp3" });

    // Test stop()
    await engine.stop();
    assert.equal(ffmpegKilled, true);
    assert.equal(playerStopped, true);

    // Test destroy()
    await engine.destroy();
    assert.equal(connectionDestroyed, true);
    assert.equal(engine.voiceConnection, null);

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("LocalEngine: audioPlayer and ffmpeg events emit 'end' and 'error'", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbm-local-engine4-"));
    const libraryDir = path.join(tmpDir, "library");
    fs.mkdirSync(libraryDir, { recursive: true });
    fs.writeFileSync(path.join(libraryDir, "song.mp3"), Buffer.from("data"));

    const mockFfmpeg = new EventEmitter();
    mockFfmpeg.stdout = new PassThrough();
    mockFfmpeg.kill = () => {};

    const mockAudioPlayer = new EventEmitter();
    mockAudioPlayer.play = () => {};
    mockAudioPlayer.stop = () => {};

    const engine = new LocalEngine({
        guildId: "g1",
        channelId: "c1",
        dataDir: tmpDir,
        audioPlayer: mockAudioPlayer,
        spawn: () => mockFfmpeg
    });

    let endEvents = [];
    let errorEvents = [];
    engine.on("end", (e) => endEvents.push(e));
    engine.on("error", (e) => errorEvents.push(e));

    await engine.play({ file_path: "song.mp3" });

    // Player goes idle naturally -> end with reason finished
    mockAudioPlayer.emit(AudioPlayerStatus.Idle);
    assert.equal(endEvents.length, 1);
    assert.equal(endEvents[0].reason, "finished");

    // Player error -> emits error
    const testErr = new Error("Audio player playback error");
    mockAudioPlayer.emit("error", testErr);
    assert.equal(errorEvents.length, 1);
    assert.equal(errorEvents[0].message, "Audio player playback error");

    // FFmpeg error -> emits error
    const spawnErr = new Error("FFmpeg spawn error");
    mockFfmpeg.emit("error", spawnErr);
    assert.equal(errorEvents.length, 2);
    assert.equal(errorEvents[1].message, "FFmpeg spawn error");

    fs.rmSync(tmpDir, { recursive: true, force: true });
});
