"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const binaries = require("../modules/binaries");

function makeBinDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "sbm-bin-"));
}

function writeBinary(dir, base, { executable = true, empty = false } = {}) {
    const filePath = path.join(dir, binaries.executableName(base));
    fs.writeFileSync(filePath, empty ? "" : "fake-binary");
    if (process.platform !== "win32") {
        fs.chmodSync(filePath, executable ? 0o755 : 0o644);
    }
    return filePath;
}

function cleanup(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

test("binaries: environment variable wins over bundled binary and DB value", () => {
    const dir = makeBinDir();
    try {
        writeBinary(dir, "ffmpeg");
        const resolved = binaries.resolveFfmpegPath({
            binDir: dir,
            env: { FFMPEG_PATH: "/custom/ffmpeg" },
            dbValue: "/db/ffmpeg",
        });
        assert.equal(resolved, "/custom/ffmpeg");
    } finally {
        cleanup(dir);
    }
});

test("binaries: bundled binary wins over a stale DB value", () => {
    const dir = makeBinDir();
    try {
        const bundled = writeBinary(dir, "ffmpeg");
        const resolved = binaries.resolveFfmpegPath({
            binDir: dir,
            env: {},
            dbValue: "C:/Users/someone/tools/ffmpeg/ffmpeg.exe",
        });
        assert.equal(resolved, bundled);
    } finally {
        cleanup(dir);
    }
});

test("binaries: DB value is used when nothing is bundled", () => {
    const dir = makeBinDir();
    try {
        const resolved = binaries.resolveFfmpegPath({
            binDir: dir,
            env: {},
            dbValue: "/opt/ffmpeg/bin/ffmpeg",
        });
        assert.equal(resolved, "/opt/ffmpeg/bin/ffmpeg");
    } finally {
        cleanup(dir);
    }
});

test("binaries: falls back to the bare command name when unconfigured", () => {
    const dir = makeBinDir();
    try {
        assert.equal(binaries.resolveFfmpegPath({ binDir: dir, env: {}, dbValue: null }), "ffmpeg");
        assert.equal(binaries.resolveYtdlpPath({ binDir: dir, env: {}, dbValue: "" }), "yt-dlp");
    } finally {
        cleanup(dir);
    }
});

test("binaries: empty or whitespace DB values are ignored", () => {
    const dir = makeBinDir();
    try {
        assert.equal(binaries.resolveYtdlpPath({ binDir: dir, env: {}, dbValue: "   " }), "yt-dlp");
    } finally {
        cleanup(dir);
    }
});

test("binaries: zero-byte files are not treated as a bundled binary", () => {
    const dir = makeBinDir();
    try {
        writeBinary(dir, "yt-dlp", { empty: true });
        const resolved = binaries.resolveYtdlpPath({ binDir: dir, env: {}, dbValue: null });
        assert.equal(resolved, "yt-dlp");
    } finally {
        cleanup(dir);
    }
});

test("binaries: non-executable files are rejected on POSIX", { skip: process.platform === "win32" }, () => {
    const dir = makeBinDir();
    try {
        writeBinary(dir, "ffmpeg", { executable: false });
        const resolved = binaries.resolveFfmpegPath({ binDir: dir, env: {}, dbValue: null });
        assert.equal(resolved, "ffmpeg");
    } finally {
        cleanup(dir);
    }
});

test("binaries: bundledStatus reports both binaries", () => {
    const dir = makeBinDir();
    try {
        writeBinary(dir, "ffmpeg");
        const status = binaries.bundledStatus({ binDir: dir });
        assert.equal(status.ffmpeg.present, true);
        assert.equal(status.ytdlp.present, false);
        assert.equal(status.ytdlp.path, null);
    } finally {
        cleanup(dir);
    }
});

test("binaries: executableName appends .exe only on Windows", () => {
    assert.equal(binaries.executableName("ffmpeg"), process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
});
