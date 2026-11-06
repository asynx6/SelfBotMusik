"use strict";

const { BaseEngine } = require("./base");

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
            // Local file: ask Lavalink to LOAD the internal stream URL so it
            // plays the real file from disk (DAVE-safe path). This only works
            // when Lavalink can reach STREAM_BASE_URL — true on the VPS, where
            // bot and Lavalink share the host.
            const baseUrl = process.env.STREAM_BASE_URL || "http://127.0.0.1:3434";
            const streamUrl = `${baseUrl}/api/stream/${trackRow.id}`;
            let loaded = null;
            try {
                const res = await this.poru.resolve({ query: streamUrl, requester: this.requester });
                if (res && res.loadType === "track" && Array.isArray(res.tracks) && res.tracks.length) {
                    loaded = res.tracks[0];
                }
            } catch (e) {
                console.warn(`[lavalink] stream resolve failed (${streamUrl}): ${e.message}`);
            }

            if (loaded) {
                track = loaded;
            } else {
                // Lavalink cannot reach the stream (remote node + local bot).
                // Keep the title metadata only: Poru then re-resolves it by
                // "author - title", so the bot still plays *something* instead
                // of silently transmitting nothing.
                console.warn(
                    `[lavalink] ⚠️  Lavalink tidak bisa mengambil stream lokal (${streamUrl}). `
                    + `Memutar versi pencarian judul sebagai gantinya. Set STREAM_BASE_URL ke URL yang `
                    + `dapat dijangkau node Lavalink (mis. http://127.0.0.1:3434 di VPS).`
                );
                track = {
                    info: {
                        title: trackRow.title || "Unknown",
                        author: trackRow.artist || trackRow.author || "Unknown",
                        length: trackRow.duration_ms || trackRow.duration || 0,
                        identifier: trackRow.identifier || String(trackRow.id),
                        uri: trackRow.uri || "",
                        isSeekable: true,
                        isStream: false,
                    }
                };
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
                    const res = await this.poru.resolve({ query, requester: this.requester });
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

        if (player.queue && typeof player.queue.add === "function") {
            player.queue.add(track);
        } else if (Array.isArray(player.queue)) {
            player.queue.push(track);
        }

        if (typeof player.play === "function") {
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
