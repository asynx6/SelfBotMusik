"use strict";

const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const LOOP_MODES = {
    OFF: 0,
    TRACK: 1,
    QUEUE: 2
};

function serializeTrack(item, isCurrent = false) {
    if (!item) return null;
    const track = item.track || item;
    const info = track.info || {};
    const rawReq = item.requester || track.requester || "—";

    const title = track.title || info.title || "Unknown";
    const author = track.artist || track.author || info.author || "Unknown";
    const duration = track.duration_ms ?? track.duration ?? info.length ?? 0;
    const uri = track.uri || info.uri || "";
    const thumbnail = track.cover_url
        || info.artworkUrl
        || (info.identifier ? `https://i.ytimg.com/vi/${info.identifier}/hqdefault.jpg` : "")
        || (track.identifier ? `https://i.ytimg.com/vi/${track.identifier}/hqdefault.jpg` : "")
        || "";
    const encoded = track.encoded || track.track || "";

    let requester = "—";
    if (typeof rawReq === "string") {
        requester = rawReq;
    } else if (rawReq && typeof rawReq === "object") {
        requester = rawReq.tag || rawReq.username || "—";
    }

    return {
        title,
        author,
        duration,
        uri,
        thumbnail,
        encoded,
        requester,
        isCurrent: Boolean(isCurrent)
    };
}

class PlayerController extends EventEmitter {
    constructor({
        library,
        createLavalinkEngine,
        createLocalEngine,
        db,
        dataDir,
        getVoiceTarget,
        onIntentionalDisconnect,
        isLavalinkReady
    } = {}) {
        super();
        this.library = library || null;
        this.createLavalinkEngine = createLavalinkEngine || null;
        this.createLocalEngine = createLocalEngine || null;
        this.db = db || null;
        this.dataDir = dataDir || null;
        this.getVoiceTarget = getVoiceTarget || null;
        this.onIntentionalDisconnect = onIntentionalDisconnect || null;
        this.isLavalinkReady = isLavalinkReady || null;

        this.queue = [];
        this.currentIndex = -1;
        this.currentEngine = null;
        this.currentEngineType = null;
        this.volume = 100;
        this.loop = LOOP_MODES.OFF;
        this.paused = false;
        this.lastError = null;

        this._stopping = false;
    }

    _resolveEngineType(track) {
        if (!track) return null;

        if (track.file_path) {
            const fullPath = path.isAbsolute(track.file_path)
                ? track.file_path
                : path.join(this.dataDir || "", "library", track.file_path);
            if (fs.existsSync(fullPath)) {
                return "local";
            }
            return null; // file_path defined but file not found on disk -> cannot play local or lavalink
        }

        if (typeof this.isLavalinkReady === "function") {
            if (!this.isLavalinkReady()) return null;
        } else if (this.isLavalinkReady === false) {
            return null;
        }

        if (typeof this.createLavalinkEngine === "function") {
            return "lavalink";
        }

        return null;
    }

    _logAudit(event, detail) {
        if (this.db && typeof this.db.prepare === "function") {
            try {
                this.db.prepare("INSERT INTO audit_log (ts, event, detail) VALUES (?, ?, ?)").run(
                    Date.now(),
                    event,
                    detail ? String(detail).slice(0, 500) : null
                );
            } catch {}
        }
    }

    _recordPlay(track) {
        if (!track) return;
        const now = Date.now();
        if (this.library && typeof this.library.recordPlay === "function") {
            try { return this.library.recordPlay(track); } catch {}
        }
        if (this.db && typeof this.db.prepare === "function") {
            try {
                if (track.id) {
                    this.db.prepare("UPDATE tracks SET play_count = play_count + 1, last_played_at = ? WHERE id = ?").run(now, track.id);
                } else if (track.source_key) {
                    this.db.prepare("UPDATE tracks SET play_count = play_count + 1, last_played_at = ? WHERE source_key = ?").run(now, track.source_key);
                }
            } catch {}
        }
    }

    _wireEngineListeners(engine) {
        if (!engine || typeof engine.on !== "function") return;

        engine.on("end", async ({ reason } = {}) => {
            if (this._stopping || reason === "stop" || this.currentEngine !== engine) return;
            await this.next();
        });

        engine.on("error", async (err) => {
            if (this._stopping || this.currentEngine !== engine) return;
            this.lastError = err;
            this._logAudit("track_error", err?.message || String(err));
            await this.next();
        });

        engine.on("stuck", async (data) => {
            if (this._stopping || this.currentEngine !== engine) return;
            this.lastError = new Error("Track stuck in playback");
            this._logAudit("track_stuck", data ? JSON.stringify(data) : "Track stuck");
            await this.next();
        });
    }

    _emitState() {
        const snap = this.getSnapshot();
        this.emit("state", snap);
        this.emit("change", snap);
    }

    async enqueue(tracks, requester = "—") {
        const list = Array.isArray(tracks) ? tracks : (tracks ? [tracks] : []);
        if (list.length === 0) {
            throw new Error("No tracks provided to enqueue");
        }

        const initialLength = this.queue.length;
        const wasPlaying = this.currentIndex >= 0 && this.currentIndex < initialLength && this.currentEngine !== null && !this._stopping;

        for (const track of list) {
            this.queue.push({ track, requester });
        }

        if (!wasPlaying) {
            this.currentIndex = initialLength;
            await this.playCurrent();
        } else {
            this._emitState();
        }

        const firstItem = this.queue[initialLength];
        const serialized = serializeTrack(firstItem, !wasPlaying);

        return {
            queued: wasPlaying,
            queuePosition: wasPlaying ? initialLength : 0,
            playing: !wasPlaying,
            batch: list.length > 1 ? list.length : undefined,
            track: serialized,
            ...serialized
        };
    }

    async playCurrent() {
        if (this.currentIndex < 0 || this.currentIndex >= this.queue.length) {
            await this.stop();
            return;
        }

        const item = this.queue[this.currentIndex];
        const targetType = this._resolveEngineType(item.track);

        if (!targetType) {
            this.lastError = new Error(`No available engine for track: ${item.track?.title || "Unknown"}`);
            this._logAudit("track_skip", this.lastError.message);
            this._emitState();
            return await this._skipForward();
        }

        try {
            if (this.currentEngineType !== targetType) {
                this.onIntentionalDisconnect?.(true);
                if (this.currentEngine) {
                    await this.currentEngine.destroy();
                    this.currentEngine = null;
                    this.currentEngineType = null;
                }

                const newEngine = targetType === "local"
                    ? await this.createLocalEngine()
                    : await this.createLavalinkEngine();

                if (!newEngine) {
                    throw new Error(`Failed to instantiate ${targetType} engine`);
                }

                this.currentEngine = newEngine;
                this.currentEngineType = targetType;
                this._wireEngineListeners(newEngine);
            }

            await this.currentEngine.play(item.track, { volume: this.volume, startMs: 0 });
            this.paused = false;
            this._recordPlay(item.track);
            this._emitState();
        } catch (err) {
            this.lastError = err;
            this._logAudit("track_error", err?.message || String(err));
            this._emitState();
            return await this._skipForward();
        }
    }

    // Skip past the current track, bypassing TRACK loop so an unplayable
    // track can't recurse playCurrent -> next -> playCurrent forever.
    async _skipForward() {
        if (this.queue.length === 0) {
            await this.stop();
            return;
        }
        this.currentIndex++;
        if (this.currentIndex < this.queue.length) {
            await this.playCurrent();
        } else if (this.loop === LOOP_MODES.QUEUE) {
            this.currentIndex = 0;
            await this.playCurrent();
        } else {
            await this.stop();
        }
    }

    async next() {
        if (this.queue.length === 0) {
            await this.stop();
            return;
        }

        if (this.loop === LOOP_MODES.TRACK) {
            await this.playCurrent();
            return;
        }

        if (this.loop === LOOP_MODES.QUEUE) {
            this.currentIndex = (this.currentIndex + 1) % this.queue.length;
            await this.playCurrent();
            return;
        }

        // loop === OFF
        this.currentIndex++;
        if (this.currentIndex < this.queue.length) {
            await this.playCurrent();
        } else {
            await this.stop();
        }
    }

    async jumpTo(index) {
        const idx = Number(index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= this.queue.length) {
            throw new RangeError("Index out of range");
        }
        this.currentIndex = idx;
        await this.playCurrent();
    }

    async stop() {
        this._stopping = true;
        try {
            if (this.currentEngine && typeof this.currentEngine.stop === "function") {
                await this.currentEngine.stop();
            }
        } finally {
            this.currentIndex = -1;
            this.queue = [];
            this.paused = false;
            this._stopping = false;
            this._emitState();
        }
    }

    async pause() {
        if (this.currentEngine && typeof this.currentEngine.pause === "function") {
            await this.currentEngine.pause();
        }
        this.paused = true;
        this._emitState();
        return { paused: this.paused };
    }

    async resume() {
        if (this.currentEngine && typeof this.currentEngine.resume === "function") {
            await this.currentEngine.resume();
        }
        this.paused = false;
        this._emitState();
        return { paused: this.paused };
    }

    async togglePause() {
        if (this.paused) {
            return await this.resume();
        } else {
            return await this.pause();
        }
    }

    async setVolume(vol) {
        const num = Number(vol);
        const clamped = Math.max(0, Math.min(200, Number.isNaN(num) ? 100 : num));
        this.volume = clamped;
        if (this.currentEngine && typeof this.currentEngine.setVolume === "function") {
            await this.currentEngine.setVolume(clamped);
        }
        this._emitState();
        return { volume: this.volume };
    }

    setLoop(mode) {
        const idx = Number(mode);
        if (!Number.isInteger(idx) || idx < 0 || idx > 2) {
            throw new Error("Invalid loop mode (0..2)");
        }
        this.loop = idx;
        this._emitState();
        return { mode: this.loop };
    }

    cycleLoop() {
        const next = (this.loop + 1) % 3;
        return this.setLoop(next);
    }

    removeAt(index) {
        const idx = Number(index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= this.queue.length) {
            throw new Error("Index out of range");
        }
        if (idx === this.currentIndex) {
            throw new Error("Cannot remove currently playing track");
        }
        const [removed] = this.queue.splice(idx, 1);
        if (idx < this.currentIndex) {
            this.currentIndex--;
        }
        this._emitState();
        return { removed: 1, remaining: this.queue.length, track: removed };
    }

    clearQueue() {
        let cleared = 0;
        if (this.currentIndex >= 0 && this.currentIndex < this.queue.length) {
            const currentItem = this.queue[this.currentIndex];
            cleared = this.queue.length - 1;
            this.queue = [currentItem];
            this.currentIndex = 0;
        } else {
            cleared = this.queue.length;
            this.queue = [];
            this.currentIndex = -1;
        }
        this._emitState();
        return { cleared, remaining: this.queue.length };
    }

    getSnapshot() {
        const currentItem = (this.currentIndex >= 0 && this.currentIndex < this.queue.length)
            ? this.queue[this.currentIndex]
            : null;

        let position = 0;
        if (this.currentEngine && typeof this.currentEngine.getPositionMs === "function") {
            try {
                position = this.currentEngine.getPositionMs() || 0;
            } catch {
                position = 0;
            }
        }

        return {
            playing: currentItem ? serializeTrack(currentItem, true) : null,
            queue: this.queue.map((item, idx) => serializeTrack(item, idx === this.currentIndex)),
            paused: this.paused,
            volume: this.volume,
            loop: this.loop,
            position
        };
    }

    async destroy() {
        await this.stop();
        if (this.currentEngine && typeof this.currentEngine.destroy === "function") {
            try { await this.currentEngine.destroy(); } catch {}
            this.currentEngine = null;
            this.currentEngineType = null;
        }
        this.removeAllListeners();
    }
}

PlayerController.PlayerController = PlayerController;
PlayerController.serializeTrack = serializeTrack;
PlayerController.LOOP_MODES = LOOP_MODES;

module.exports = PlayerController;
