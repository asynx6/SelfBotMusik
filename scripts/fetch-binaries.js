"use strict";

/**
 * Fetch the external binaries this project needs into ./bin.
 *
 *   node scripts/fetch-binaries.js              # skip anything already present
 *   node scripts/fetch-binaries.js --force      # re-download (yt-dlp updates)
 *   node scripts/fetch-binaries.js --only=ffmpeg
 *   node scripts/fetch-binaries.js --no-prune   # keep other-platform binaries
 *   node scripts/fetch-binaries.js --strict     # non-zero exit on failure
 *
 * Why project-local binaries: the deployment target is a Pterodactyl panel,
 * where the container image has no ffmpeg and the only persistent writable
 * directory is the server volume (this folder). Dropping the binaries in
 * ./bin makes the instance self-contained and removes the need to configure
 * absolute paths per machine.
 *
 * Sources (both are single-file downloads, no archive extraction needed):
 *   - ffmpeg : eugeneware/ffmpeg-static release assets, gzipped
 *   - yt-dlp : yt-dlp/yt-dlp standalone builds
 *
 * Failure is non-fatal by default so `npm install` never breaks; the app
 * falls back to the settings table and then PATH.
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { Transform } = require("node:stream");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { spawnSync } = require("node:child_process");

const PROJECT_ROOT = path.join(__dirname, "..");
const BIN_DIR = path.join(PROJECT_ROOT, "bin");

const FFMPEG_RELEASE_API = "https://api.github.com/repos/eugeneware/ffmpeg-static/releases/latest";
const YTDLP_DOWNLOAD_BASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";

const IS_WINDOWS = process.platform === "win32";
const MB = 1024 * 1024;

// ---------------------------------------------------------------- utilities

function log(message) {
    process.stdout.write(`${message}\n`);
}

function targetFileName(base) {
    return IS_WINDOWS ? `${base}.exe` : base;
}

function detectLibc() {
    if (process.platform !== "linux") return null;
    try {
        const report = typeof process.report?.getReport === "function" ? process.report.getReport() : null;
        return report?.header?.glibcVersionRuntime ? "glibc" : "musl";
    } catch {
        // Assume glibc: every mainstream Pterodactyl yolk is Debian-based.
        return "glibc";
    }
}

function ffmpegAssetName(platform, arch) {
    const map = {
        "win32-x64": "ffmpeg-win32-x64",
        "linux-x64": "ffmpeg-linux-x64",
        "linux-arm64": "ffmpeg-linux-arm64",
        "linux-arm": "ffmpeg-linux-arm",
        "linux-ia32": "ffmpeg-linux-ia32",
        "darwin-x64": "ffmpeg-darwin-x64",
        "darwin-arm64": "ffmpeg-darwin-arm64",
    };
    return map[`${platform}-${arch}`] || null;
}

function ytdlpAssetName(platform, arch, libc) {
    if (platform === "win32") {
        if (arch === "ia32") return "yt-dlp_x86.exe";
        if (arch === "arm64") return "yt-dlp_arm64.exe";
        return "yt-dlp.exe";
    }
    if (platform === "darwin") return "yt-dlp_macos";
    if (platform === "linux") {
        if (libc === "musl") {
            return arch === "arm64" ? "yt-dlp_musllinux_aarch64" : "yt-dlp_musllinux";
        }
        if (arch === "arm64") return "yt-dlp_linux_aarch64";
        // armv7l is only published as .zip — out of scope here.
        if (arch === "arm") return null;
        return "yt-dlp_linux";
    }
    return null;
}

async function downloadTo(url, destination, { gunzip = false, label = "download", quiet = false } = {}) {
    const response = await fetch(url, {
        redirect: "follow",
        headers: { "user-agent": "SelfBotMusik-setup" },
    });

    if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
    }

    const totalBytes = Number(response.headers.get("content-length")) || 0;
    const tmpPath = `${destination}.part`;
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });

    let received = 0;
    let lastReported = -1;

    const meter = new Transform({
        transform(chunk, _encoding, callback) {
            received += chunk.length;
            if (!quiet && totalBytes > 0) {
                const pct = Math.floor((received / totalBytes) * 100);
                if (pct >= lastReported + 20 || pct === 100) {
                    lastReported = pct;
                    log(`  ${label}: ${pct}% (${(received / MB).toFixed(1)} / ${(totalBytes / MB).toFixed(1)} MB)`);
                }
            }
            callback(null, chunk);
        },
    });

    const sink = fs.createWriteStream(tmpPath);
    const stages = [Readable.fromWeb(response.body), meter];
    if (gunzip) stages.push(zlib.createGunzip());
    stages.push(sink);

    try {
        await pipeline(...stages);
    } catch (error) {
        await fs.promises.rm(tmpPath, { force: true });
        throw error;
    }

    await fs.promises.rename(tmpPath, destination);
    return received;
}

function makeExecutable(filePath) {
    if (IS_WINDOWS) return;
    fs.chmodSync(filePath, 0o755);
}

function verifyBinary(filePath, args) {
    const result = spawnSync(filePath, args, { encoding: "utf8", timeout: 30000 });
    if (result.error) throw new Error(result.error.message);
    if (result.status !== 0) {
        const detail = String(result.stderr || result.stdout || "").trim().slice(0, 300);
        throw new Error(`exit code ${result.status}${detail ? `: ${detail}` : ""}`);
    }
    return String(result.stdout || "").split("\n")[0].trim();
}

/**
 * Remove binaries that belong to a different platform than the current one.
 *
 * This matters when a developer runs `npm install` on Windows and then uploads
 * the folder to a Linux container: `bin/ffmpeg.exe` is dead weight there (~100 MB
 * against the panel disk quota) and can never be executed. Deleting is safe —
 * `npm run setup:bin` re-fetches at any time.
 */
function pruneForeignBinaries(binDir = BIN_DIR) {
    // Names that only make sense on the *other* platform.
    const foreignNames = IS_WINDOWS ? ["ffmpeg", "yt-dlp"] : ["ffmpeg.exe", "yt-dlp.exe"];
    const removed = [];

    for (const name of foreignNames) {
        const candidate = path.join(binDir, name);
        if (!fs.existsSync(candidate)) continue;
        try {
            fs.rmSync(candidate, { force: true });
            removed.push(name);
        } catch {
            // Best effort: a locked file must not abort the setup.
        }
    }
    return removed;
}

// ------------------------------------------------------------------ fetchers

async function fetchFfmpeg({ force, quiet }) {
    const destination = path.join(BIN_DIR, targetFileName("ffmpeg"));
    if (!force && fs.existsSync(destination)) {
        log("ffmpeg   : already present, skipping");
        return { name: "ffmpeg", skipped: true };
    }

    const asset = ffmpegAssetName(process.platform, process.arch);
    if (!asset) {
        throw new Error(`no prebuilt ffmpeg for ${process.platform}/${process.arch}`);
    }
    if (process.platform === "linux" && detectLibc() === "musl") {
        log("ffmpeg   : warning — the prebuilt binary requires glibc; use a Debian-based image");
    }

    log(`ffmpeg   : resolving latest ffmpeg-static release`);
    const metaResponse = await fetch(FFMPEG_RELEASE_API, {
        headers: { "user-agent": "SelfBotMusik-setup", accept: "application/vnd.github+json" },
    });
    if (!metaResponse.ok) {
        throw new Error(`GitHub API returned HTTP ${metaResponse.status} (rate limit?)`);
    }
    const release = await metaResponse.json();
    const assetEntry = (release.assets || []).find((entry) => entry.name === `${asset}.gz`);
    if (!assetEntry) {
        throw new Error(`asset ${asset}.gz not found in release ${release.tag_name}`);
    }

    log(`ffmpeg   : downloading ${asset}.gz (${(assetEntry.size / MB).toFixed(1)} MB) from ${release.tag_name}`);
    await downloadTo(assetEntry.browser_download_url, destination, {
        gunzip: true,
        label: "ffmpeg",
        quiet,
    });
    makeExecutable(destination);

    const version = verifyBinary(destination, ["-version"]);
    const size = fs.statSync(destination).size;
    log(`ffmpeg   : ok — ${version} (${(size / MB).toFixed(1)} MB)`);
    return { name: "ffmpeg", version };
}

async function fetchYtdlp({ force, quiet }) {
    const destination = path.join(BIN_DIR, targetFileName("yt-dlp"));
    if (!force && fs.existsSync(destination)) {
        log("yt-dlp   : already present, skipping");
        return { name: "yt-dlp", skipped: true };
    }

    const asset = ytdlpAssetName(process.platform, process.arch, detectLibc());
    if (!asset) {
        throw new Error(`no standalone yt-dlp build for ${process.platform}/${process.arch}`);
    }

    log(`yt-dlp   : downloading ${asset}`);
    await downloadTo(`${YTDLP_DOWNLOAD_BASE}/${asset}`, destination, {
        label: "yt-dlp",
        quiet,
    });
    makeExecutable(destination);

    const version = verifyBinary(destination, ["--version"]);
    const size = fs.statSync(destination).size;
    log(`yt-dlp   : ok — ${version} (${(size / MB).toFixed(1)} MB)`);
    return { name: "yt-dlp", version };
}

// ---------------------------------------------------------------------- main

async function main() {
    const argv = process.argv.slice(2);
    const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
    const force = flags.has("--force");
    const quiet = flags.has("--quiet");
    const strict = flags.has("--strict");
    const prune = !flags.has("--no-prune");

    const onlyArg = argv.find((arg) => arg.startsWith("--only="));
    const requested = onlyArg
        ? onlyArg.slice("--only=".length).split(",").map((value) => value.trim()).filter(Boolean)
        : ["ffmpeg", "yt-dlp"];

    if (process.env.SKIP_BINARY_FETCH === "1") {
        log("setup:bin — SKIP_BINARY_FETCH=1, skipping binary download");
        return 0;
    }

    log(`setup:bin — target ${process.platform}/${process.arch}${detectLibc() ? ` (${detectLibc()})` : ""}`);

    if (prune) {
        const removed = pruneForeignBinaries();
        if (removed.length > 0) {
            log(`setup:bin — removed foreign-platform binaries: ${removed.join(", ")}`);
        }
    }

    const tasks = [];
    if (requested.includes("ffmpeg")) tasks.push(fetchFfmpeg);
    if (requested.includes("yt-dlp") || requested.includes("ytdlp")) tasks.push(fetchYtdlp);

    if (tasks.length === 0) {
        log("setup:bin — nothing selected, exiting");
        return 0;
    }

    const failures = [];
    for (const task of tasks) {
        try {
            await task({ force, quiet });
        } catch (error) {
            const message = error?.message || String(error);
            failures.push(message);
            log(`  failed: ${message}`);
        }
    }

    if (failures.length > 0) {
        log("");
        log("setup:bin — some binaries could not be fetched:");
        for (const message of failures) log(`  - ${message}`);
        log("The app will fall back to settings.ffmpeg_path / settings.ytdlp_path, then PATH.");
        log("Re-run `npm run setup:bin` once the network issue is resolved.");
        return strict ? 1 : 0;
    }

    log("setup:bin — done");
    return 0;
}

if (require.main === module) {
    main()
        .then((code) => process.exit(code))
        .catch((error) => {
            log(`setup:bin — unexpected failure: ${error?.message || error}`);
            process.exit(process.argv.includes("--strict") ? 1 : 0);
        });
}

module.exports = { ffmpegAssetName, ytdlpAssetName, targetFileName, detectLibc, pruneForeignBinaries };
