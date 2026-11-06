"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    StreamType
} = require("@discordjs/voice");
const { BaseEngine } = require("./base");

class LocalEngine extends BaseEngine {
    constructor({
        client,
        guildId,
        channelId,
        ffmpegPath,
        dataDir,
        adapterCreator,
        voiceConnection,
        audioPlayer,
        spawn: spawnFn,
        createAudioResource: createAudioResourceFn,
        voiceReadyTimeoutMs = 15000
    } = {}) {
        super();
        this.name = "local";
        this.client = client;
        this.guildId = guildId;
        this.channelId = channelId;
        this.ffmpegPath = ffmpegPath || "ffmpeg";
        this.dataDir = dataDir || path.join(__dirname, "..", "..", "data");
        this.adapterCreator = adapterCreator;

        this._spawn = spawnFn || spawn;
        this._createAudioResource = createAudioResourceFn || createAudioResource;

        this.ffmpegProcess = null;
        this.currentResource = null;
        this.volume = 100;
        this._stopping = false;
        this._destroyed = false;
        // How long to wait for the voice connection to become ready before
        // giving up. Configurable so tests do not have to wait the full time.
        this.voiceReadyTimeoutMs = voiceReadyTimeoutMs;

        this.audioPlayer = audioPlayer || createAudioPlayer();
        this.voiceConnection = voiceConnection || null;

        this._setupPlayerListeners();
        this._ensureVoiceConnection();
    }

    _setupPlayerListeners() {
        if (!this.audioPlayer || typeof this.audioPlayer.on !== "function") return;

        this.audioPlayer.on(AudioPlayerStatus.Playing, () => {
            clearTimeout(this._playStartTimer);
        });

        this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
            if (this._destroyed) return;
            clearTimeout(this._playStartTimer);
            this._cleanupFfmpeg();
            const reason = this._stopping ? "stop" : "finished";
            this._stopping = false;
            this.emit("end", { reason });
        });

        this.audioPlayer.on("error", (error) => {
            if (this._destroyed) return;
            this._cleanupFfmpeg();
            this.emit("error", error);
        });
    }

    _ensureVoiceConnection() {
        if (this.voiceConnection) return this.voiceConnection;

        // The bridge's adapter creator delivers the gateway packets in the
        // order @discordjs/voice needs, so its UDP socket actually starts.
        // The stock guild.voiceAdapterCreator can leave the connection stuck
        // in "signalling" — silent playback, no error.
        let adapterCreator = this.adapterCreator;
        if (!adapterCreator && this.client) {
            const { adapterCreatorFor } = require("../voice-bridge");
            adapterCreator = adapterCreatorFor(this.client, this.guildId);
        }

        if (this.channelId && this.guildId && adapterCreator) {
            this.voiceConnection = joinVoiceChannel({
                channelId: this.channelId,
                guildId: this.guildId,
                adapterCreator,
                selfDeaf: true,
                selfMute: false
            });
            this._watchVoiceConnection();
        }
        return this.voiceConnection;
    }

    _watchVoiceConnection() {
        const conn = this.voiceConnection;
        if (!conn || typeof conn.on !== "function") return;
        conn.on("stateChange", (oldState, newState) => {
            this.lastVoiceStatus = newState.status;
            console.log(`[voice] ${oldState.status} -> ${newState.status}`);
        });
        conn.on("error", (err) => {
            this.lastVoiceError = err?.message || String(err);
            console.error(`[voice] error: ${this.lastVoiceError}`);
        });
    }

    /**
     * Block until the voice connection is ready to carry audio.
     *
     * Without this the audio player happily starts against a connection that
     * never reached "ready", so ffmpeg decodes into the void: the bot shows a
     * track playing but produces no sound at all.
     */
    async _waitForReady(timeoutMs = this.voiceReadyTimeoutMs) {
        const conn = this.voiceConnection;
        if (!conn) return false;
        // Not a real @discordjs/voice connection (an injected test double or a
        // custom adapter): there is no readiness state machine to wait for.
        if (!conn.state || typeof conn.state.status !== "string") return true;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const status = conn.state?.status;
            if (status === VoiceConnectionStatus.Ready) return true;
            if (status === VoiceConnectionStatus.Destroyed) {
                throw new Error(this.lastVoiceError || "Koneksi voice dihancurkan");
            }
            await new Promise((r) => setTimeout(r, 150));
        }
        throw new Error(
            `Koneksi voice belum siap setelah ${Math.round(timeoutMs / 1000)} detik `
            + `(status: ${conn.state?.status || "tidak diketahui"})`
            + `${this.lastVoiceError ? ` — ${this.lastVoiceError}` : ""}`
        );
    }

    _cleanupFfmpeg() {
        if (this.ffmpegProcess) {
            try {
                this.ffmpegProcess.kill();
            } catch {}
            this.ffmpegProcess = null;
        }
    }

    async play(trackRow, { volume, startMs } = {}) {
        if (!trackRow || !trackRow.file_path) {
            throw new Error("Local track missing file_path");
        }

        const fullPath = path.isAbsolute(trackRow.file_path)
            ? trackRow.file_path
            : path.join(this.dataDir, "library", trackRow.file_path);

        if (!fs.existsSync(fullPath)) {
            throw new Error(`Physical audio file does not exist: ${fullPath}`);
        }

        if (typeof volume === "number") {
            this.volume = Math.max(0, Math.min(200, volume));
        }

        this._cleanupFfmpeg();
        this._stopping = false;

        const ffmpegArgs = [];
        if (startMs && startMs > 0) {
            ffmpegArgs.push("-ss", String(startMs / 1000));
        }
        ffmpegArgs.push("-i", fullPath, "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1");

        const ffmpeg = this._spawn(this.ffmpegPath, ffmpegArgs, {
            stdio: ["ignore", "pipe", "inherit"]
        });
        this.ffmpegProcess = ffmpeg;

        ffmpeg.on("error", (err) => {
            this._cleanupFfmpeg();
            this.emit("error", err);
        });

        const resource = this._createAudioResource(ffmpeg.stdout, {
            inputType: StreamType.Raw,
            inlineVolume: true
        });
        this.currentResource = resource;

        if (resource?.volume && typeof resource.volume.setVolumeLogarithmic === "function") {
            resource.volume.setVolumeLogarithmic(this.volume / 100);
        }

        if (startMs && startMs > 0 && resource) {
            resource.playbackDuration = startMs;
        }

        // Everything below can fail (no permission, voice never ready, …).
        // ffmpeg is already running by then, so a throw without cleanup leaves
        // an orphan process decoding into a closed pipe — the stuck ffmpeg
        // banner the user sees in the terminal.
        try {
            this._ensureVoiceConnection();
            if (!this.voiceConnection) {
                throw new Error("Failed to establish voice connection (joinVoiceChannel returned null)");
            }

            // Do not hand audio to a connection that is not ready yet: the
            // player would report "playing" while nothing is ever transmitted.
            await this._waitForReady();

            if (typeof this.voiceConnection.subscribe === "function" && this.audioPlayer) {
                this.voiceConnection.subscribe(this.audioPlayer);
            }

            if (this.audioPlayer && typeof this.audioPlayer.play === "function") {
                this.audioPlayer.play(resource);

                // Watchdog: if Playing never arrives (e.g. no subscriber, dead
                // connection), the track would hang forever — fail loudly instead.
                clearTimeout(this._playStartTimer);
                this._playStartTimer = setTimeout(() => {
                    if (this._destroyed || this.audioPlayer?.state?.status === AudioPlayerStatus.Playing) return;
                    this._cleanupFfmpeg();
                    this.emit("error", new Error("Playback did not start within 5s"));
                }, 5000);
            }
        } catch (err) {
            this._cleanupFfmpeg();
            this.currentResource = null;
            throw err;
        }
    }

    async pause() {
        if (this.audioPlayer && typeof this.audioPlayer.pause === "function") {
            this.audioPlayer.pause();
        }
    }

    async resume() {
        if (this.audioPlayer && typeof this.audioPlayer.unpause === "function") {
            this.audioPlayer.unpause();
        }
    }

    async stop() {
        this._stopping = true;
        this._cleanupFfmpeg();
        if (this.audioPlayer && typeof this.audioPlayer.stop === "function") {
            this.audioPlayer.stop();
        }
    }

    async setVolume(volume) {
        this.volume = Math.max(0, Math.min(200, Number(volume) || 0));
        if (this.currentResource?.volume && typeof this.currentResource.volume.setVolumeLogarithmic === "function") {
            this.currentResource.volume.setVolumeLogarithmic(this.volume / 100);
        }
    }

    getPositionMs() {
        const duration = this.audioPlayer?.state?.resource?.playbackDuration
            ?? this.currentResource?.playbackDuration
            ?? 0;
        return typeof duration === "number" ? duration : 0;
    }

    async destroy() {
        this._destroyed = true;
        clearTimeout(this._playStartTimer);
        this._stopping = true;
        this._cleanupFfmpeg();

        if (this.audioPlayer) {
            if (typeof this.audioPlayer.removeAllListeners === "function") {
                try { this.audioPlayer.removeAllListeners(); } catch {}
            }
            if (typeof this.audioPlayer.stop === "function") {
                try { this.audioPlayer.stop(); } catch {}
            }
        }

        if (this.voiceConnection && typeof this.voiceConnection.destroy === "function") {
            try { this.voiceConnection.destroy(); } catch {}
        }

        this.voiceConnection = null;
        this.currentResource = null;
    }
}

module.exports = { LocalEngine };
