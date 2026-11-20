"use strict";

const { BaseEngine } = require("./base");

/**
 * `poru.resolve` throws the useless
 * "Cannot create property 'loadType' on string '<html>…'" when a node sits
 * behind a reverse proxy that answers with an HTML error page instead of JSON.
 * Surface the real cause instead.
 */
async function safeResolve(poru, payload) {
    let res;
    try {
        res = await poru.resolve(payload);
    } catch (e) {
        const msg = String(e?.message || e);
        if (/Cannot create property 'loadType'|<html|Unexpected token|is not valid JSON/i.test(msg)) {
            throw new Error("Node Lavalink membalas halaman error (bukan JSON) — node sedang down atau dibatasi");
        }
        throw e;
    }
    if (!res || typeof res !== "object" || typeof res.loadType !== "string") {
        throw new Error("Node Lavalink membalas data yang tidak valid — coba lagi atau ganti node");
    }
    return res;
}

class LavalinkEngine extends BaseEngine {
    constructor({ poru, guildId } = {}) {
        super();
        this.name = "lavalink";
        this.poru = poru;
        this.guildId = guildId;

        this._listenersWired = false;
        this._trackEnded = false;
        this._activePlayer = null;
        this._onTrackEnd = null;
        this._onQueueEnd = null;
        this._onTrackError = null;
        this._onTrackStuck = null;
        this._onPlayerTrackEnd = null;
        this._onPlayerTrackError = null;
        this._onPlayerTrackStuck = null;
    }

    _emitEnd(reason = "finished") {
        if (this._trackEnded) return;
        this._trackEnded = true;
        this.emit("end", { reason });
    }

    _getPlayer() {
        return this.poru?.players?.get(this.guildId) || null;
    }

    /**
     * True when the Lavalink node runs on this machine, so `127.0.0.1:3434`
     * actually points at our HTTP stream. Public/remote nodes must never be
     * given a loopback URL — they would resolve it against their own host.
     */
    _isLocalNode() {
        const opts = this.poru?.nodes?.get?.("main")?.options || {};
        const host = String(opts.host || "").toLowerCase();
        if (process.env.STREAM_BASE_URL) return true; // explicit override wins
        return host === "127.0.0.1" || host === "localhost" || host === "::1";
    }

    /**
     * Resolve a library row through the node by its original URI (or by
     * "artist - title" when the row has none).
     *
     * This is what makes a track from History / Library playable at all: the
     * SQLite row stores metadata, not an encoded Lavalink track, so the node
     * has to look it up again.
     */
    async _resolveRemote(trackRow) {
        const uri = trackRow.uri || trackRow.identifier || "";
        const titleQuery = [trackRow.artist || trackRow.author, trackRow.title]
            .filter(Boolean).join(" - ");
        // Prefer the stored URL: it points at the exact video the user saved.
        const candidates = [uri, titleQuery].filter(Boolean);
        if (!candidates.length) {
            throw new Error(
                `Tidak bisa memutar "${trackRow.title || "Unknown"}": `
                + "baris perpustakaan tidak punya URI maupun judul"
            );
        }

        const errors = [];
        for (const query of candidates) {
            try {
                const res = await safeResolve(this.poru, { query, requester: this.requester });
                if (res.loadType === "track" && res.tracks?.length) return res.tracks[0];
                if (res.loadType === "search" && res.tracks?.length) return res.tracks[0];
                if (res.loadType === "playlist" && res.tracks?.length) return res.tracks[0];
                errors.push(`${query}: loadType=${res.loadType}`);
            } catch (e) {
                errors.push(`${query}: ${e.message}`);
            }
        }
        throw new Error(
            `Tidak bisa memutar "${trackRow.title || "Unknown"}" — node Lavalink gagal me-resolve `
            + `(${errors.join(" | ")})`
        );
    }

    _setupListeners(player) {
        if (this._listenersWired) return;

        // Wire Poru-level events (standard Poru architecture)
        if (this.poru && typeof this.poru.on === "function") {
            this._onTrackEnd = (p, track, data) => {
                if (p?.guildId && p.guildId !== this.guildId) return;
                const reason = data?.reason || track?.reason || "finished";
                this._emitEnd(reason);
            };

            this._onQueueEnd = (p) => {
                if (p?.guildId && p.guildId !== this.guildId) return;
                this._emitEnd("finished");
            };

            this._onTrackError = (p, track, data) => {
                if (p?.guildId && p.guildId !== this.guildId) return;
                const err = data?.exception || data || new Error("Lavalink track error");
                this.emit("error", err instanceof Error ? err : new Error(String(err?.message || err)));
            };

            this._onTrackStuck = (p, track, thresholdMs) => {
                if (p?.guildId && p.guildId !== this.guildId) return;
                this.emit("stuck", { thresholdMs, track });
            };

            this.poru.on("trackEnd", this._onTrackEnd);
            this.poru.on("queueEnd", this._onQueueEnd);
            this.poru.on("trackError", this._onTrackError);
            this.poru.on("trackStuck", this._onTrackStuck);
        }

        // Also wire player-level events if player is an EventEmitter (useful for isolated mocks)
        if (player && typeof player.on === "function" && player !== this.poru) {
            this._activePlayer = player;

            this._onPlayerTrackEnd = (track, data) => {
                const reason = (data && data.reason) || (track && track.reason) || "finished";
                this._emitEnd(reason);
            };

            this._onPlayerTrackError = (track, data) => {
                const err = (data && data.exception) || data || track || new Error("Lavalink track error");
                this.emit("error", err instanceof Error ? err : new Error(String(err?.message || err)));
            };

            this._onPlayerTrackStuck = (track, thresholdMs) => {
                this.emit("stuck", { thresholdMs, track });
            };

            player.on("trackEnd", this._onPlayerTrackEnd);
            player.on("trackError", this._onPlayerTrackError);
            player.on("trackStuck", this._onPlayerTrackStuck);
        }

        this._listenersWired = true;
    }

    _removeListeners() {
        if (!this._listenersWired) return;

        if (this.poru) {
            const remove = typeof this.poru.off === "function"
                ? this.poru.off.bind(this.poru)
                : typeof this.poru.removeListener === "function"
                    ? this.poru.removeListener.bind(this.poru)
                    : null;
            if (remove) {
                if (this._onTrackEnd) remove("trackEnd", this._onTrackEnd);
                if (this._onQueueEnd) remove("queueEnd", this._onQueueEnd);
                if (this._onTrackError) remove("trackError", this._onTrackError);
                if (this._onTrackStuck) remove("trackStuck", this._onTrackStuck);
            }
        }

        if (this._activePlayer) {
            const removeP = typeof this._activePlayer.off === "function"
                ? this._activePlayer.off.bind(this._activePlayer)
                : typeof this._activePlayer.removeListener === "function"
                    ? this._activePlayer.removeListener.bind(this._activePlayer)
                    : null;
            if (removeP) {
                if (this._onPlayerTrackEnd) removeP("trackEnd", this._onPlayerTrackEnd);
                if (this._onPlayerTrackError) removeP("trackError", this._onPlayerTrackError);
                if (this._onPlayerTrackStuck) removeP("trackStuck", this._onPlayerTrackStuck);
            }
            this._activePlayer = null;
        }

        this._listenersWired = false;
    }

    async play(trackRow, { volume, startMs } = {}) {
        if (!trackRow) {
            throw new Error("trackRow is required");
        }
        if (trackRow.source_type && trackRow.source_type !== "lavalink" && !trackRow.file_path) {
            throw new Error(`Unsupported source_type: ${trackRow.source_type}; LavalinkEngine requires source_type === 'lavalink'`);
        }

        const player = this._getPlayer();
        if (!player) {
            throw new Error(`No Poru player found for guild ${this.guildId}`);
        }

        this._setupListeners(player);
        this._trackEnded = false;

        let track;
        if (trackRow.file_path) {
            // A downloaded file is only playable through Lavalink when the node
            // can reach this bot's HTTP stream. A remote/public node resolves
            // `127.0.0.1` to ITSELF, so the real fix there is to resolve the
            // original URI (YouTube etc.) instead of the dead loopback URL.
            // Only stream local files when the node is on this machine.
            const localNode = this._isLocalNode();
            if (!localNode) {
                track = await this._resolveRemote(trackRow);
            } else {
                const baseUrl = process.env.STREAM_BASE_URL || "http://127.0.0.1:3434";
                const streamUrl = `${baseUrl}/api/stream/${trackRow.id}`;
                let loaded = null;
                try {
                    const res = await safeResolve(this.poru, { query: streamUrl, requester: this.requester });
                    if (res && res.loadType === "track" && Array.isArray(res.tracks) && res.tracks.length) {
                        loaded = res.tracks[0];
                    }
                } catch (e) {
                    console.warn(`[lavalink] stream resolve failed (${streamUrl}): ${e.message}`);
                }
                track = loaded || await this._resolveRemote(trackRow);
            }
        } else if (trackRow.encoded || trackRow.track) {
            track = {
                track: trackRow.encoded || trackRow.track,
                info: {
                    title: trackRow.title || "Unknown",
                    author: trackRow.artist || trackRow.author || "Unknown",
                    length: trackRow.duration_ms || trackRow.duration || 0,
                    uri: trackRow.uri || "",
                    identifier: trackRow.identifier || "",
                    isSeekable: true,
                    isStream: false
                }
            };
        } else if (trackRow.info) {
            track = trackRow;
        } else {
            track = {
                info: {
                    title: trackRow.title || "Unknown",
                    author: trackRow.artist || trackRow.author || "Unknown",
                    length: trackRow.duration_ms || trackRow.duration || 0,
                    uri: trackRow.uri || "",
                    identifier: trackRow.identifier || ""
                }
            };
        }

        // Poru's Player.play() only calls updatePlayer() when the queued object
        // carries a base64 `track`. A row from the SQLite library is metadata
        // only; without resolving it here, play() resolves successfully while
        // Lavalink is never asked to play anything — the "pesan muncul tapi
        // tidak nyanyi" symptom.
        if (!track?.track && typeof this.poru?.resolve === "function") {
            const query = trackRow.uri
                || [trackRow.artist || trackRow.author, trackRow.title].filter(Boolean).join(" - ");
            if (query) {
                try {
                    const res = await safeResolve(this.poru, { query, requester: this.requester });
                    if (res && typeof res === "object" && Array.isArray(res.tracks) && res.tracks.length) {
                        track = res.tracks[0];
                    }
                } catch (e) {
                    console.warn(`[lavalink] resolve gagal untuk "${query}": ${e.message}`);
                }
            }
        }

        if (!track?.track) {
            throw new Error(
                `Lavalink tidak bisa memutar "${trackRow.title || "Unknown"}": `
                + "tidak ada encoded track (resolve gagal atau node tidak mengembalikan lagu)"
            );
        }

        // Play the track DIRECTLY through the node instead of pushing it onto
        // Poru's own player.queue.
        //
        // Poru's queue is a second scheduler running beside ours: every
        // engine.play() appended a track, and Poru replays those leftovers on
        // every TrackEndEvent regardless of what the controller wants. The tail
        // of a long session was a burst of tracks firing back to back, then
        // silence. One owner of the queue is enough — ours.
        const encoded = track.track;
        if (process.env.DEBUG_TRACK === "1") {
            console.log(
                `[lavalink] load "${trackRow.title || "?"}" → `
                + `${track.info?.title || "?"} | ${track.info?.identifier || "?"} | `
                + `${String(encoded || "").slice(0, 24)}… | session=${player.node?.sessionId || "?"}`
            );
        }
        if (player.node?.rest?.updatePlayer) {
            await player.node.rest.updatePlayer({
                guildId: this.guildId,
                data: { track: { encoded } },
            });
            player.currentTrack = track;
            player.position = 0;
            player.isPlaying = true;
            // Drop anything Poru queued earlier so it cannot replay later.
            if (player.queue) {
                try {
                    if (typeof player.queue.clear === "function") player.queue.clear();
                    player.queue.length = 0;
                } catch { /* best effort */ }
            }
        } else if (typeof player.play === "function") {
            // Fallback for mocks / older Poru without a reachable rest client.
            if (player.queue && typeof player.queue.add === "function") {
                player.queue.add(track);
            } else if (Array.isArray(player.queue)) {
                player.queue.push(track);
            }
            await player.play();
        }

        if (typeof volume === "number" && typeof player.setVolume === "function") {
            await player.setVolume(volume);
        }

        if (startMs && startMs > 0) {
            if (typeof player.seek === "function") {
                await player.seek(startMs);
            } else if (typeof player.seekTo === "function") {
                await player.seekTo(startMs);
            }
        }
    }

    async pause() {
        const player = this._getPlayer();
        if (!player) return;
        if (typeof player.pause === "function") {
            await player.pause(true);
        }
    }

    async resume() {
        const player = this._getPlayer();
        if (!player) return;
        if (typeof player.resume === "function") {
            await player.resume();
        } else if (typeof player.pause === "function") {
            await player.pause(false);
        }
    }

    async stop() {
        const player = this._getPlayer();
        if (!player) return;
        if (typeof player.stop === "function") {
            await player.stop();
        } else if (typeof player.skip === "function") {
            await player.skip();
        }
    }

    async setVolume(volume) {
        const player = this._getPlayer();
        if (!player) return;
        if (typeof player.setVolume === "function") {
            await player.setVolume(volume);
        }
    }

    getPositionMs() {
        const player = this._getPlayer();
        if (!player) return 0;
        return typeof player.position === "number" ? player.position : 0;
    }

    async destroy() {
        this._removeListeners();
        const player = this._getPlayer();
        if (player) {
            if (player.queue) {
                try {
                    if (typeof player.queue.clear === "function") {
                        player.queue.clear();
                    }
                    player.queue.length = 0;
                } catch {}
            }
            if (typeof player.stop === "function") {
                try { await player.stop(); } catch {}
            }
            if (typeof player.destroy === "function") {
                try { await player.destroy(); } catch {}
            }
        }
    }
}

module.exports = { LavalinkEngine };
