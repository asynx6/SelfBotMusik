"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ffmpegAssetName, ytdlpAssetName, targetFileName, pruneForeignBinaries } =
    require("../scripts/fetch-binaries");

// The deployment target is a Pterodactyl container: linux / x64 / glibc.
// These cases lock the asset mapping without needing to run on Linux.

test("fetch: ffmpeg asset for the Pterodactyl target (linux/x64)", () => {
    assert.equal(ffmpegAssetName("linux", "x64"), "ffmpeg-linux-x64");
});

test("fetch: ffmpeg asset mapping covers the supported matrix", () => {
    assert.equal(ffmpegAssetName("win32", "x64"), "ffmpeg-win32-x64");
    assert.equal(ffmpegAssetName("linux", "arm64"), "ffmpeg-linux-arm64");
    assert.equal(ffmpegAssetName("darwin", "arm64"), "ffmpeg-darwin-arm64");
    assert.equal(ffmpegAssetName("linux", "s390x"), null);
});

test("fetch: yt-dlp asset for linux glibc and musl", () => {
    assert.equal(ytdlpAssetName("linux", "x64", "glibc"), "yt-dlp_linux");
    assert.equal(ytdlpAssetName("linux", "arm64", "glibc"), "yt-dlp_linux_aarch64");
    assert.equal(ytdlpAssetName("linux", "x64", "musl"), "yt-dlp_musllinux");
    assert.equal(ytdlpAssetName("linux", "arm64", "musl"), "yt-dlp_musllinux_aarch64");
});

test("fetch: yt-dlp asset for Windows and macOS", () => {
    assert.equal(ytdlpAssetName("win32", "x64", null), "yt-dlp.exe");
    assert.equal(ytdlpAssetName("win32", "arm64", null), "yt-dlp_arm64.exe");
    assert.equal(ytdlpAssetName("darwin", "arm64", null), "yt-dlp_macos");
});

test("fetch: unsupported linux/arm is reported instead of guessed", () => {
    assert.equal(ytdlpAssetName("linux", "arm", "glibc"), null);
});

test("fetch: targetFileName follows the platform convention", () => {
    assert.equal(targetFileName("ffmpeg"), process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
});

test("fetch: prune removes only the other platform's binaries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbm-fetch-"));
    try {
        for (const name of ["ffmpeg", "ffmpeg.exe", "yt-dlp", "yt-dlp.exe"]) {
            fs.writeFileSync(path.join(dir, name), "x");
        }
        fs.writeFileSync(path.join(dir, "README.md"), "keep me");

        const removed = pruneForeignBinaries(dir);

        if (process.platform === "win32") {
            assert.deepEqual(removed.sort(), ["ffmpeg", "yt-dlp"]);
            assert.equal(fs.existsSync(path.join(dir, "ffmpeg.exe")), true);
            assert.equal(fs.existsSync(path.join(dir, "yt-dlp.exe")), true);
        } else {
            assert.deepEqual(removed.sort(), ["ffmpeg.exe", "yt-dlp.exe"]);
            assert.equal(fs.existsSync(path.join(dir, "ffmpeg")), true);
            assert.equal(fs.existsSync(path.join(dir, "yt-dlp")), true);
        }
        // Documentation and anything else must be untouched.
        assert.equal(fs.existsSync(path.join(dir, "README.md")), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("fetch: prune is a no-op on an empty directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbm-fetch-"));
    try {
        assert.deepEqual(pruneForeignBinaries(dir), []);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
