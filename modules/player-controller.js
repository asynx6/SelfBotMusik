"use strict";

const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const LOOP_MODES = {
    OFF: 0,
    TRACK: 1,
    QUEUE: 2
};

/**
 * Drop already-played items once this many have piled up.
 *
 * `_skipForward` / `next` only advance `currentIndex`; nothing ever removes the
 * consumed entries, so the array grows for the whole uptime of the process.
 * Each state snapshot serializes the entire array (~240 B per track), which
 * turns a long autoplay session into megabytes of JSON per push, twice a
 * second — GC churn that never settles and RSS that keeps climbing.
 */
const QUEUE_COMPACT_THRESHOLD = 64;

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
        id: track.id ?? null,
        title,
        author,
        duration,
        uri,
        thumbnail,
        encoded,
        downloaded: Boolean(track.file_path),
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
        isLavalinkReady,
        autoplayEnabled
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
        this.autoplayEnabled = autoplayEnabled !== false; // default: true
        this._onTrackEndAutoplay = null; // returns one prepared track (pure)
        this._onAutoplayPrefetch = null; // fills the autoplay buffer in advance

        this.queue = [];
        this.currentIndex = -1;
        this.currentEngine = null;
        this.currentEngineType = null;
        this.volume = 100;
        this.loop = LOOP_MODES.OFF;
        this.paused = false;
        this.lastError = null;
        // `lastError` is a persistent record of the last failure (tests and
        // audit rely on it). `currentError` is the copy the dashboard shows;
        // it is cleared as soon as a track plays successfully.
        this.currentError = null;

        this._stopping = false;
    }

    _hasLocalFile(track) {
        if (!track?.file_path) return false;
        const fullPath = path.isAbsolute(track.file_path)
            ? track.file_path
            : path.join(this.dataDir || "", "library", track.file_path);
        return fs.existsSync(fullPath);
    }

    _resolveEngineType(track) {
        if (!track) return null;

        // ONE voice owner per session. Switching between LavalinkEngine and
        // LocalEngine destroys a voice connection and joins again — exactly
        // the leave/rejoin seen on every skip with a mixed queue. Lavalink can
        // play online tracks AND local files (stream URL, then URL/title
        // resolve), so prefer it for the whole session whenever it is ready.
        if (typeof this.createLavalinkEngine === "function"
            && (!this.isLavalinkReady || this.isLavalinkReady())) {
            return "lavalink";
        }

        // Lavalink off: only files that physically exist can be played.
        if (this._hasLocalFile(track)) return "local";

        return null;
    }

    setAutoplayProvider(providerFn) {
        this._onTrackEndAutoplay = typeof providerFn === "function" ? providerFn : null;
    }

    /** Called (fire-and-forget) while a track plays, so candidates are ready. */
    setAutoplayPrefetcher(prefetchFn) {
        this._onAutoplayPrefetch = typeof prefetchFn === "function" ? prefetchFn : null;
    }

    /** Map a dashboard queue index (0 = current) to the internal array index. */
    fromUiIndex(index) {
        const i = Number(index);
        if (!Number.isInteger(i)) return i;
        return this.currentIndex >= 0 ? this.currentIndex + i : i;
    }

    /**
     * Activate an engine, destroying the previous one only when the type
     * actually changes. Keeping the same engine is what keeps the bot inside
     * the voice channel across skip / track-end.
     */
    async _activateEngine(targetType) {
        if (this.currentEngineType === targetType) return;

        this.onIntentionalDisconnect?.(true);
        try {
            if (this.currentEngine) {
                await this.currentEngine.destroy();
                this.currentEngine = null;
                this.currentEngineType = null;
            }

            // Prefer the latest voice target so a fresh LocalEngine connects
            // to the channel the user actually selected.
            const vt = typeof this.getVoiceTarget === "function" ? this.getVoiceTarget() : null;
            const newEngine = targetType === "local"
                ? await this.createLocalEngine({ channelId: vt?.channelId })
                : await this.createLavalinkEngine();

            if (!newEngine) throw new Error(`Failed to instantiate ${targetType} engine`);

            this.currentEngine = newEngine;
            this.currentEngineType = targetType;
            this._wireEngineListeners(newEngine);
        } finally {
            // Genuine drops after the handoff must trigger auto-rejoin again.
            this.onIntentionalDisconnect?.(false);
        }
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
                    this.db.prepare("INSERT INTO history (track_id, played_at, ms_played) VALUES (?, ?, 0)").run(track.id, now);
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
            this.currentError = err;
            this._logAudit("track_error", err?.message || String(err));
            await this._skipForward(this.queue[this.currentIndex]);
        });

        engine.on("stuck", async (data) => {
            if (this._stopping || this.currentEngine !== engine) return;
            this.lastError = new Error("Track stuck in playback");
            this.currentError = this.lastError;
            this._logAudit("track_stuck", data ? JSON.stringify(data) : "Track stuck");
            await this._skipForward(this.queue[this.currentIndex]);
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

    /**
     * "Putar Sekarang": start this selection immediately instead of appending
     * it to the end of the queue. The first selected track becomes the current
     * one (top of the dashboard queue); anything that was waiting stays behind
     * it, and the engine/voice session is reused so the bot never leaves VC.
     */
    async playNow(tracks, requester = "Web") {
        const list = Array.isArray(tracks) ? tracks : (tracks ? [tracks] : []);
        if (!list.length) throw new Error("No tracks provided to play");

        // Nothing is playing: enqueue() already starts playback immediately.
        if (!this.currentEngine || this.currentIndex < 0 || this.currentIndex >= this.queue.length) {
            return await this.enqueue(list, requester);
        }

        const items = list.map((track) => ({ track, requester }));
        const insertAt = this.currentIndex + 1;
        this.queue.splice(insertAt, 0, ...items);
        this.currentIndex = insertAt;
        await this.playCurrent();

        const serialized = serializeTrack(this.queue[insertAt], true);
        return {
            queued: false,
            queuePosition: 0,
            playing: true,
            batch: list.length > 1 ? list.length : undefined,
            track: serialized,
            ...serialized,
        };
    }

    /**
     * Discard entries that have already finished playing and re-base
     * `currentIndex` to 0. Called before playback starts, which is the only
     * moment nothing needs to look back at earlier entries — `next()` resolves
     * its autoplay seed before calling into `playCurrent()`.
     */
    _compactQueue() {
        if (this.currentIndex < QUEUE_COMPACT_THRESHOLD) return 0;
        if (this.currentIndex >= this.queue.length) return 0;

        const dropped = this.currentIndex;
        this.queue.splice(0, dropped);
        this.currentIndex = 0;
        return dropped;
    }

    async playCurrent() {
        this._compactQueue();
        if (this.currentIndex < 0 || this.currentIndex >= this.queue.length) {
            await this.stop();
            return;
        }

        const item = this.queue[this.currentIndex];
        const targetType = this._resolveEngineType(item.track);

        if (!targetType) {
            const lavalinkReady = !this.isLavalinkReady || this.isLavalinkReady();
            const reason = (item.track && !item.track.file_path && !lavalinkReady)
                ? `Track online butuh Lavalink tapi tidak ada node Lavalink yang terhubung — `
                  + `atur Lavalink di Pengaturan, atau unduh lagunya untuk diputar offline`
                : `Tidak ada engine untuk lagu: ${item.track?.title || "Unknown"}`;
            this.lastError = new Error(reason);
            this.currentError = this.lastError;
            this._logAudit("track_skip", this.lastError.message);
            this._emitState();
            return await this._skipForward(item);
        }

        try {
            await this._activateEngine(targetType);

            try {
                await this.currentEngine.play(item.track, { volume: this.volume, startMs: 0 });
            } catch (err) {
                // A remote Lavalink node cannot reach /api/stream/:id and may
                // also fail to resolve by URL. A downloaded file is still
                // playable — fall back instead of skipping the track.
                if (targetType === "lavalink" && this._hasLocalFile(item.track)
                    && typeof this.createLocalEngine === "function") {
                    console.warn(`[player] Lavalink gagal: ${err.message} — fallback LocalEngine`);
                    await this._activateEngine("local");
                    await this.currentEngine.play(item.track, { volume: this.volume, startMs: 0 });
                } else {
                    throw err;
                }
            }

            this.paused = false;
            // A successful play clears the banner. `lastError` stays as the
            // persistent record of the previous failure.
            this.currentError = null;
            this._recordPlay(item.track);
            this._emitState();

            // Prepare similar candidates while this track plays, so an empty
            // queue never waits for a network search at track end.
            if (this.autoplayEnabled && this._onAutoplayPrefetch
                && this.currentIndex >= this.queue.length - 1) {
                Promise.resolve()
                    .then(() => this._onAutoplayPrefetch(item.track))
                    .catch((e) => console.warn("[autoplay] prefetch:", e.message));
            }
        } catch (err) {
            this.lastError = err;
            this.currentError = err;
            this._logAudit("track_error", err?.message || String(err));
            this._emitState();
            return await this._skipForward(item);
        }
    }

    // Skip past the current track, bypassing TRACK loop so an unplayable
    // track can't recurse playCurrent -> next -> playCurrent forever.
    // failedItem guards the QUEUE-loop wrap: if the wrap lands back on the
    // item that just failed (e.g. single-track queue), stop instead of looping.
    async _skipForward(failedItem = null) {
        if (this.queue.length === 0) {
            await this.stop();
            return;
        }
        this.currentIndex++;
        if (this.currentIndex < this.queue.length) {
            await this.playCurrent();
        } else if (this.loop === LOOP_MODES.QUEUE) {
            if (failedItem && this.queue[0] === failedItem) {
                await this.stop();
                return;
            }
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

        // loop OFF: an explicitly queued next track always wins over autoplay.
        const upcoming = this.currentIndex + 1;
        if (upcoming < this.queue.length) {
            this.currentIndex = upcoming;
            await this.playCurrent();
            return;
        }

        // Queue exhausted: consume a candidate that was prepared in advance.
        if (this.autoplayEnabled && this._onTrackEndAutoplay) {
            const lastTrack = this.queue[this.currentIndex]?.track || null;
            try {
                const nextTrack = await this._onTrackEndAutoplay(lastTrack);
                if (nextTrack) {
                    // Append exactly once. The old code called playNext() both
                    // here and inside the provider, duplicating every track and
                    // leaving the index pointing past the new item.
                    this.queue.push({ track: nextTrack, requester: "Autoplay" });
                    this.currentIndex = this.queue.length - 1;
                    await this.playCurrent();
                    return;
                }
            } catch (e) {
                console.error("Autoplay error:", e.message);
            }
        }
        await this.stop();
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
            // Keep the engine and its voice session alive. A natural queue end
            // must NOT make the bot leave the channel — only disconnect()
            // (Stop button / Disconnect) tears the voice connection down.
        } finally {
            this.currentIndex = -1;
            this.queue = [];
            this.paused = false;
            this._stopping = false;
            this._emitState();
        }
    }

    /**
     * Tear down the active engine and, with it, the Discord voice session.
     *
     * The LocalEngine owns the real voice connection for offline playback, so
     * destroying the engine is what actually makes the bot leave the channel.
     * `stop()` alone is not enough: it silences playback but leaves the voice
     * connection open.
     */
    async disconnect() {
        const engine = this.currentEngine;
        this.currentEngine = null;
        this.currentEngineType = null;
        if (engine && typeof engine.destroy === "function") {
            try { await engine.destroy(); } catch (e) {
                this._logAudit("engine_destroy_error", e?.message || String(e));
            }
        }
        this.currentIndex = -1;
        this.queue = [];
        this.paused = false;
        this.currentError = null;
        this._emitState();
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

    playNext(tracks, requester = "Web") {
        if (!tracks) return { added: 0 };
        const list = Array.isArray(tracks) ? tracks : [tracks];
        const valid = list.filter(Boolean);
        if (!valid.length) return { added: 0 };

        const items = valid.map((t) => ({ track: t, requester }));
        const insertPos = this.currentIndex >= 0 ? this.currentIndex + 1 : 0;
        this.queue.splice(insertPos, 0, ...items);

        if (this.currentIndex === -1) {
            this.currentIndex = 0;
            this.playCurrent().catch(() => {});
        }
        this._emitState();
        return { added: items.length, position: insertPos };
    }

    shuffle() {
        if (this.queue.length <= 1) return { shuffled: false, count: this.queue.length };

        // Keep currently playing track in place, shuffle the upcoming tracks
        const startIdx = this.currentIndex >= 0 ? this.currentIndex + 1 : 0;
        const upcoming = this.queue.slice(startIdx);

        // Fisher-Yates shuffle
        for (let i = upcoming.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [upcoming[i], upcoming[j]] = [upcoming[j], upcoming[i]];
        }

        this.queue = this.queue.slice(0, startIdx).concat(upcoming);
        this._emitState();
        return { shuffled: true, count: upcoming.length };
    }

    reorder(oldIndex, newIndex) {
        const from = Number(oldIndex);
        const to = Number(newIndex);
        if (!Number.isInteger(from) || !Number.isInteger(to)) {
            throw new Error("oldIndex and newIndex must be integers");
        }
        if (from < 0 || from >= this.queue.length || to < 0 || to >= this.queue.length) {
            throw new Error("Index out of bounds");
        }
        if (from === to) return { moved: false };

        // Can't move currently playing track
        if (from === this.currentIndex || to === this.currentIndex) {
            throw new Error("Cannot move to or from currently playing position");
        }

        const [item] = this.queue.splice(from, 1);
        this.queue.splice(to, 0, item);

        // Adjust currentIndex if affected
        if (from < this.currentIndex && to >= this.currentIndex) {
            this.currentIndex--;
        } else if (from > this.currentIndex && to <= this.currentIndex) {
            this.currentIndex++;
        }

        this._emitState();
        return { moved: true, from, to };
    }

    // True when the track with this library id is the currently playing item.
    isPlayingTrack(id) {
        if (this.currentIndex < 0 || this.currentIndex >= this.queue.length) return false;
        const cur = this.queue[this.currentIndex];
        return !!(cur && cur.track && cur.track.id !== undefined && Number(cur.track.id) === Number(id));
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

        // The dashboard shows the current track plus what is coming up. Played
        // entries stay in the internal array (needed for QUEUE loop / history)
        // but must not accumulate in the UI list forever.
        const start = Math.max(0, this.currentIndex);
        const visibleQueue = this.queue.slice(start);

        return {
            playing: currentItem ? serializeTrack(currentItem, true) : null,
            queue: visibleQueue.map((item, idx) => serializeTrack(item, idx === 0 && !!currentItem)),
            paused: this.paused,
            volume: this.volume,
            loop: this.loop,
            position,
            // Surfaced to the dashboard so a track that could not play shows a
            // reason instead of silently disappearing.
            lastError: this.currentError ? String(this.currentError.message || this.currentError) : null
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
