"use strict";

/**
 * Central resolver for external binaries (ffmpeg, yt-dlp).
 *
 * Goal: the app must run on a Pterodactyl-style container without anyone
 * configuring absolute paths. Resolution order is deliberately:
 *
 *   1. environment variable  (FFMPEG_PATH / YTDLP_PATH)  — explicit override
 *   2. ./bin/<name>          (bundled via `npm run setup:bin`) — project-local
 *   3. settings table value  (legacy manual configuration)
 *   4. bare command name     (looked up on PATH)
 *
 * Bundled binaries win over the settings table on purpose: a database copied
 * from another machine may still hold a stale absolute path (e.g. a Windows
 * path inside a Linux container) and silently break playback. The bundled
 * file is always correct for the platform it was fetched on.
 */

const fs = require("node:fs");
const path = require("node:path");

const PROJECT_ROOT = path.join(__dirname, "..");
const DEFAULT_BIN_DIR = path.join(PROJECT_ROOT, "bin");

const BINARY_SPECS = {
    ffmpeg: {
        base: "ffmpeg",
        envVar: "FFMPEG_PATH",
        settingKey: "ffmpeg_path",
        fallback: "ffmpeg",
    },
    ytdlp: {
        base: "yt-dlp",
        envVar: "YTDLP_PATH",
        settingKey: "ytdlp_path",
        fallback: "yt-dlp",
    },
};

function executableName(base) {
    return process.platform === "win32" ? `${base}.exe` : base;
}

function isRunnable(filePath) {
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size === 0) return false;
        // Windows has no executable bit; existence is the only signal.
        if (process.platform !== "win32") {
            fs.accessSync(filePath, fs.constants.X_OK);
        }
        return true;
    } catch {
        return false;
    }
}

function findBundledBinary(base, binDir) {
    const dir = binDir || DEFAULT_BIN_DIR;
    const candidates = [path.join(dir, executableName(base))];
    // Tolerate a binary committed without the .exe suffix on Windows.
    if (process.platform === "win32") candidates.push(path.join(dir, base));

    for (const candidate of candidates) {
        if (isRunnable(candidate)) return candidate;
    }
    return null;
}

function resolveBinary(spec, { binDir, env = process.env, dbValue } = {}) {
    const fromEnv = env ? env[spec.envVar] : null;
    if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();

    const bundled = findBundledBinary(spec.base, binDir);
    if (bundled) return bundled;

    if (dbValue !== null && dbValue !== undefined && String(dbValue).trim()) {
        return String(dbValue).trim();
    }

    return spec.fallback;
}

function resolveFfmpegPath(options = {}) {
    return resolveBinary(BINARY_SPECS.ffmpeg, options);
}

function resolveYtdlpPath(options = {}) {
    return resolveBinary(BINARY_SPECS.ytdlp, options);
}

/**
 * Report which binaries are bundled locally. Used by the boot log so an
 * operator can see at a glance whether the container is self-contained.
 */
function bundledStatus({ binDir } = {}) {
    const dir = binDir || DEFAULT_BIN_DIR;
    const status = {};
    for (const [key, spec] of Object.entries(BINARY_SPECS)) {
        const resolved = findBundledBinary(spec.base, dir);
        status[key] = { present: Boolean(resolved), path: resolved };
    }
    return status;
}

module.exports = {
    BINARY_SPECS,
    DEFAULT_BIN_DIR,
    executableName,
    isRunnable,
    findBundledBinary,
    resolveFfmpegPath,
    resolveYtdlpPath,
    bundledStatus,
};
