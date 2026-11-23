"use strict";

/**
 * Per-track loudness levelling.
 *
 * Every track arrives at a different integrated loudness — a -9 LUFS single and
 * a -20 LUFS acoustic ballad sound wildly different at the same slider position,
 * which is exactly what "volume 20% tapi ada yang gede ada yang kecil" means.
 * Measuring each track and folding the difference into the volume we send keeps
 * the perceived level constant.
 *
 * Measurement uses ffmpeg's EBU R128 meter over a yt-dlp stream, the same
 * binaries the downloader already uses. Results are cached by source key in the
 * `tracks` table so a track is measured once, ever.
 */

const { spawn } = require("child_process");
const path = require("path");

const TARGET_LUFS = -14;
const MEASURE_SECONDS = 45;
const MAX_GAIN_DB = 12;
const MEASURE_TIMEOUT_MS = 25000;

function parseLoudness(stderr) {
    // ebur128 prints a summary on exit; take the last Integrated line.
    const matches = [...String(stderr).matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g)];
    if (!matches.length) return null;
    const lufs = Number(matches[matches.length - 1][1]);
    return Number.isFinite(lufs) ? lufs : null;
}

/**
 * Gain in dB that brings `lufs` to the target, clamped so a quiet recording is
 * never boosted into clipping-range and a hot master is never silenced.
 */
function gainForLufs(lufs, target = TARGET_LUFS) {
    if (!Number.isFinite(lufs)) return 0;
    const gain = target - lufs;
    return Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, gain));
}

function dbToFactor(db) {
    return Math.pow(10, db / 20);
}

class LoudnessService {
    constructor({ db, library, binaries, ytdlpPath, ffmpegPath, spawnFn } = {}) {
        this.db = db || null;
        this.library = library || null;
        this.binaries = binaries || null;
        this._ytdlp = ytdlpPath || null;
        this._ffmpeg = ffmpegPath || null;
        this._spawn = spawnFn || spawn;
        this._inFlight = new Map();
        this._enabled = true;
    }

    _resolve(which) {
        const explicit = which === "ytdlp" ? this._ytdlp : this._ffmpeg;
        if (explicit) return explicit;
        const mod = this.binaries || require("./binaries");
        return which === "ytdlp"
            ? mod.resolveYtdlpPath({ dbValue: this._dbValue("ytdlp_path") })
            : mod.resolveFfmpegPath({ dbValue: this._dbValue("ffmpeg_path") });
    }

    _dbValue(key) {
        try {
            if (this.db && typeof this.db.prepare === "function") {
                const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
                return row?.value || null;
            }
        } catch { /* settings optional */ }
        return null;
    }

    setEnabled(on) {
        this._enabled = !!on;
    }

    get enabled() {
        return this._enabled;
    }

    /** Cached LUFS for a library row, or null when never measured. */
    getCached(track) {
        if (!track) return null;
        const row = track.loudness_lufs ?? this._readColumn(track.id);
        const n = Number(row);
        return Number.isFinite(n) && n !== 0 ? n : null;
    }

    _readColumn(id) {
        if (!id) return null;
        try {
            if (this.db && typeof this.db.prepare === "function") {
                const r = this.db.prepare("SELECT loudness_lufs FROM tracks WHERE id = ?").get(id);
                return r?.loudness_lufs ?? null;
            }
        } catch { /* column may not exist yet */ }
        return null;
    }

    _writeColumn(id, lufs) {
        if (!id) return;
        try {
            if (this.db && typeof this.db.prepare === "function") {
                this.db.prepare("UPDATE tracks SET loudness_lufs = ? WHERE id = ?").run(lufs, id);
            }
        } catch { /* best effort */ }
    }

    /**
     * The multiplier to apply to the user's volume for this track. 1 when the
     * track has not been measured (or levelling is off), so playback is never
     * blocked waiting for a measurement.
     */
    factorFor(track) {
        if (!this._enabled) return 1;
        const lufs = this.getCached(track);
        if (lufs === null) return 1;
        return dbToFactor(gainForLufs(lufs));
    }

    /**
     * Measure a track's integrated loudness and cache it. Returns the LUFS or
     * null. Never throws: a failed measurement is not a playback failure.
     */
    async measure(track) {
        if (!track) return null;
        const cached = this.getCached(track);
        if (cached !== null) return cached;

        const key = track.id || track.source_key || track.uri;
        if (!key) return null;
        if (this._inFlight.has(key)) return this._inFlight.get(key);

        const p = this._measureUncached(track)
            .catch(() => null)
            .finally(() => this._inFlight.delete(key));
        this._inFlight.set(key, p);
        return p;
    }

    async _measureUncached(track) {
        // Metadata-only rows (Spotify & friends) point at a page yt-dlp cannot
        // stream. The same mirror the engine does applies here: search by
        // "artist title" so the measurement uses the audio actually played.
        const usesPlayableUri = track.uri && !/open\.spotify\.com|music\.apple\.com|deezer\.com|tidal\.com|qobuz\.com/i.test(track.uri);
        const searchTerm = [track.artist || track.author, track.title].filter(Boolean).join(" ").trim();
        const uri = usesPlayableUri
            ? track.uri
            : (searchTerm ? `ytsearch1:${searchTerm}` : (track.identifier
                ? `https://www.youtube.com/watch?v=${track.identifier}` : ""));
        if (!uri) return null;

        const ytdlp = this._resolve("ytdlp") || "yt-dlp";
        const ffmpeg = this._resolve("ffmpeg") || "ffmpeg";

        const lufs = await this._runPipeline(ytdlp, ffmpeg, uri);
        if (lufs === null) return null;
        this._writeColumn(track.id, lufs);
        return lufs;
    }

    _runPipeline(ytdlp, ffmpeg, uri) {
        return new Promise((resolve) => {
            let settled = false;
            let stderr = "";
            const done = (v) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { dl?.kill("SIGKILL"); } catch {}
                try { mx?.kill("SIGKILL"); } catch {}
                resolve(v);
            };

            let dl;
            let mx;
            try {
                dl = this._spawn(ytdlp, ["-f", "bestaudio", "-o", "-", "--no-warnings", "--no-playlist", uri], {
                    stdio: ["ignore", "pipe", "ignore"],
                });
                mx = this._spawn(ffmpeg, [
                    "-hide_banner", "-nostdin",
                    "-t", String(MEASURE_SECONDS),
                    "-i", "pipe:0",
                    "-af", `ebur128=framelog=quiet`,
                    "-f", "null", "-",
                ], { stdio: ["pipe", "ignore", "pipe"] });
            } catch {
                return done(null);
            }

            const timer = setTimeout(() => done(null), MEASURE_TIMEOUT_MS);

            dl.on("error", () => done(null));
            mx.on("error", () => done(null));
            mx.on("close", () => done(parseLoudness(stderr)));
            mx.stderr.on("data", (c) => {
                stderr += c.toString();
                if (stderr.length > 200000) stderr = stderr.slice(-100000);
            });

            // yt-dlp writes the audio stream to ffmpeg's stdin.
            dl.stdout.pipe(mx.stdin);
            dl.stdout.on("error", () => done(null));
            mx.stdin.on("error", () => { /* ffmpeg closed early after -t */ });
        });
    }
}

LoudnessService.TARGET_LUFS = TARGET_LUFS;
LoudnessService.parseLoudness = parseLoudness;
LoudnessService.gainForLufs = gainForLufs;
LoudnessService.dbToFactor = dbToFactor;

module.exports = { LoudnessService, parseLoudness, gainForLufs, dbToFactor, TARGET_LUFS };
