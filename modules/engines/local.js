"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
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
        createAudioResource: createAudioResourceFn
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

        let adapterCreator = this.adapterCreator;
        if (!adapterCreator && this.client) {
            const guild = this.client.guilds?.cache?.get(this.guildId)
                || (typeof this.client.guilds?.resolve === "function" ? this.client.guilds.resolve(this.guildId) : null);
            adapterCreator = guild?.voiceAdapterCreator;
        }

        if (this.channelId && this.guildId && adapterCreator) {
            this.voiceConnection = joinVoiceChannel({
                channelId: this.channelId,
                guildId: this.guildId,
                adapterCreator,
                selfDeaf: true,
                selfMute: false
            });
        }
        return this.voiceConnection;
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

        this._ensureVoiceConnection();
        if (!this.voiceConnection) {
            throw new Error("Failed to establish voice connection (joinVoiceChannel returned null)");
        }
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
