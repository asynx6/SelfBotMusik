"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const { parseLoudness, gainForLufs, dbToFactor, TARGET_LUFS } = require("../modules/loudness");

test("parseLoudness reads the integrated value from an ebur128 summary", () => {
    const summary = `
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -13.0 LUFS
    Threshold: -23.5 LUFS

  Loudness range:
    LRA:         4.4 LU
`;
    assert.equal(parseLoudness(summary), -13);
    assert.equal(parseLoudness("-20.5 LUFS"), null, "a bare unit is not an integrated value");
    assert.equal(parseLoudness(""), null);
});

test("gainForLufs brings a track to the target and clamps both directions", () => {
    assert.equal(gainForLufs(TARGET_LUFS), 0, "a track already at target needs no gain");
    assert.equal(gainForLufs(-20), 6, "quiet track is lifted toward the target");
    assert.equal(gainForLufs(-9), -5, "hot master is turned down toward the target");
    assert.equal(gainForLufs(-60), 12, "boost is clamped");
    assert.equal(gainForLufs(0), -12, "attenuation is clamped");
    assert.equal(gainForLufs(null), 0);
});

test("dbToFactor converts dB to a linear multiplier", () => {
    assert.ok(Math.abs(dbToFactor(0) - 1) < 1e-9);
    assert.ok(Math.abs(dbToFactor(6) - 1.995262) < 1e-5);
    assert.ok(Math.abs(dbToFactor(-6) - 0.501187) < 1e-5);
});

// ---- Service behaviour with a fake spawn ----

function fakeChild({ stdout = "", stderr = "", exitCode = 0 } = {}) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.pipe = (dest) => { dest.emit("pipe", child.stdout); return dest; };
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.kill = () => {};
    setImmediate(() => {
        if (stderr) child.stderr.emit("data", Buffer.from(stderr));
        child.emit("close", exitCode);
    });
    return child;
}

function makeService(spawnImpl, dbRows = {}) {
    const { LoudnessService } = require("../modules/loudness");
    const written = [];
    const db = {
        prepare(sql) {
            return {
                get: () => ({ loudness_lufs: dbRows.cached ?? null }),
                run: (lufs, id) => { written.push({ lufs, id }); },
            };
        },
    };
    const svc = new LoudnessService({
        db,
        spawnFn: spawnImpl,
        ytdlpPath: "yt-dlp",
        ffmpegPath: "ffmpeg",
    });
    return { svc, written };
}

test("measure() caches the result and does not re-run for the same track", async () => {
    let spawned = 0;
    const spawnImpl = () => {
        spawned++;
        return fakeChild({ stderr: "    I:         -19.5 LUFS" });
    };
    const { svc, written } = makeService(spawnImpl);

    const track = { id: 7, uri: "https://www.youtube.com/watch?v=abc" };
    const first = await svc.measure(track);
    assert.equal(first, -19.5);
    assert.equal(written.length, 1, "value is persisted to the tracks table");

    // Second call for the same row is served from the cache.
    svc.getCached = () => -19.5;
    const second = await svc.measure(track);
    assert.equal(second, -19.5);
    assert.equal(spawned, 2, "only the first call spawned the pipeline");
});

test("factorFor lifts quiet tracks and attenuates loud ones", async () => {
    const { svc } = makeService(() => fakeChild({ stderr: "I: -20.0 LUFS" }));

    svc.getCached = () => -20;
    const quiet = svc.factorFor({ id: 1 });
    assert.ok(quiet > 1, "quiet track is lifted toward the target");

    svc.getCached = () => -8;
    const loud = svc.factorFor({ id: 2 });
    assert.ok(loud < 1, "loud track is attenuated");

    svc.getCached = () => null;
    assert.equal(svc.factorFor({ id: 3 }), 1, "unmeasured track plays at the user's volume");
});

test("a failed measurement never throws and never blocks playback", async () => {
    const spawnImpl = () => { throw new Error("spawn ENOENT"); };
    const { svc } = makeService(spawnImpl);
    assert.equal(await svc.measure({ id: 9, uri: "https://x" }), null);
    assert.equal(svc.factorFor({ id: 9 }), 1);
});

test("disabled levelling leaves volume untouched", () => {
    const { svc } = makeService(() => fakeChild());
    svc.getCached = () => -30;
    svc.setEnabled(false);
    assert.equal(svc.factorFor({ id: 1 }), 1);
});
