/**
 * Spike: Local Voice Probe Script
 * -----------------------------------------------------------
 * Tahap 0 (Spike) - Bagian 10 dari spec 2026-10-27-fondasi-musik-design.md
 *
 * Pertanyaan: apakah `discord.js-selfbot-v13` bisa mengirim audio dari file
 * lokal ke voice channel secara stabil menggunakan `@discordjs/voice` + ffmpeg?
 *
 * Kriteria lulus:
 * 1. Join voice channel dan audio terdengar jelas.
 * 2. Memutar terus selama 30 menit tanpa putus, tanpa desync atau suara patah.
 * 3. Handoff Lavalink -> lokal -> Lavalink di guild yang sama berhasil dengan
 *    jeda di bawah 3 detik dan tanpa state voice yang menggantung.
 * 4. Setelah koneksi voice sengaja diputus, rejoin berhasil dan audio berlanjut.
 *
 * Dijalankan oleh pemilik project di VPS.
 * Skrip ini dibuang setelah spike selesai.
 *
 * Usage:
 *   node scripts/spikes/local-voice.js [guildId] [channelId] [audioFilePath]
 *
 * Jika argumen tidak diberikan, guildId & channelId dibaca dari database SQLite
 * (data/app.sqlite via modules/database.js). Jika belum diset, prompt petunjuk.
 */

"use strict";

require("dotenv").config();

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { Client } = require("discord.js-selfbot-v13");
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    StreamType,
    VoiceConnectionStatus,
    AudioPlayerStatus,
    getVoiceConnection,
} = require("@discordjs/voice");

// Load database module for fallback guild/channel IDs
const dbModule = require("../../modules/database");

const TOKEN = process.env.TOKEN_USER;

if (!TOKEN) {
    console.error("❌ Missing TOKEN_USER in .env. Add it and try again.");
    process.exit(1);
}

// Parse CLI arguments
const [, , guildIdArg, channelIdArg, audioFilePathArg] = process.argv;
const argsProvided = guildIdArg && channelIdArg && audioFilePathArg;

let guildId = guildIdArg;
let channelId = channelIdArg;
let audioFilePath = audioFilePathArg;

// If args not provided, try loading from database
if (!argsProvided) {
    const rt = dbModule.getAllSettings();
    guildId = rt.guild_id || "";
    channelId = rt.channel_id || "";
    audioFilePath = "";
}

// Validate required parameters
if (!guildId || !channelId || !audioFilePath) {
    console.error("");
    console.error("Usage: node scripts/spikes/local-voice.js [guildId] [channelId] [audioFilePath]");
    console.error("");
    console.error("Arguments:");
    console.error("  guildId      - Discord guild (server) ID");
    console.error("  channelId    - Voice channel ID to join");
    console.error("  audioFilePath - Path to audio file (mp3, wav, ogg, etc.)");
    console.error("");
    console.error("If omitted, guildId and channelId are read from database (data/app.sqlite).");
    console.error("Configure them via the web dashboard or set them in the database directly.");
    console.error("");
    process.exit(1);
}

// Resolve audio file path
const resolvedAudioPath = path.resolve(audioFilePath);
if (!fs.existsSync(resolvedAudioPath)) {
    console.error(`❌ Audio file not found: ${resolvedAudioPath}`);
    process.exit(1);
}

console.log("📋 Spike Configuration:");
console.log(`   Guild ID:      ${guildId}`);
console.log(`   Channel ID:    ${channelId}`);
console.log(`   Audio File:    ${resolvedAudioPath}`);
console.log("");

// Create Discord client
const client = new Client({ checkUpdate: false });

// Voice connection and player references
let voiceConnection = null;
let audioPlayer = null;
let ffmpegProcess = null;
let startTime = null;
let statusLogInterval = null;

// Helper to log voice connection status changes
function logVoiceStatus(label, oldState, newState) {
    const status = newState?.status || newState;
    console.log(`🔊 Voice ${label}: ${status}`);
}

// Helper to log audio player status changes
function logPlayerStatus(label, oldState, newState) {
    const status = newState?.status || newState;
    console.log(`🎵 Player ${label}: ${status}`);
}

// Timer to log playback duration every 5 seconds
function startDurationTimer() {
    startTime = Date.now();
    statusLogInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        console.log(`⏱️  Playback duration: ${mins}m ${secs.toString().padStart(2, "0")}s`);
    }, 5000);
}

function stopDurationTimer() {
    if (statusLogInterval) {
        clearInterval(statusLogInterval);
        statusLogInterval = null;
    }
}

// Clean shutdown handler
async function shutdown(signal) {
    console.log(`\n🛑 Received ${signal}, cleaning up...`);

    stopDurationTimer();

    // Kill ffmpeg process
    if (ffmpegProcess && !ffmpegProcess.killed) {
        console.log("🔪 Killing ffmpeg process...");
        ffmpegProcess.kill("SIGKILL");
    }

    // Destroy audio player
    if (audioPlayer) {
        console.log("🔪 Destroying audio player...");
        audioPlayer.stop(true);
    }

    // Disconnect voice connection
    if (voiceConnection) {
        console.log("🔪 Disconnecting voice connection...");
        voiceConnection.destroy();
    }

    // Also cleanup any lingering voice connection from @discordjs/voice
    const existingConnection = getVoiceConnection(guildId);
    if (existingConnection) {
        existingConnection.destroy();
    }

    // Destroy Discord client
    console.log("🔪 Destroying Discord client...");
    client.destroy();

    console.log("✅ Cleanup complete. Exiting.");
    process.exit(0);
}

// Handle shutdown signals
process.on("SIGINT", () => shutdown("SIGINT (Ctrl+C)"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Process-level safety nets
process.on("uncaughtException", (err) => {
    console.error("⚠️  uncaughtException:", err?.message || err);
    shutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
    console.error("⚠️  unhandledRejection:", reason?.message || reason);
});

// Client ready event
client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag} (${client.user.id})`);

    // Get guild and verify it exists
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
        console.error(`❌ Guild not found: ${guildId}`);
        console.error("   Make sure the bot is in this guild and the ID is correct.");
        await shutdown("guild not found");
        return;
    }
    console.log(`📍 Guild: ${guild.name} (${guild.id})`);

    // Get voice channel and verify it exists
    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
        console.error(`❌ Channel not found: ${channelId}`);
        console.error("   Make sure the channel exists and the ID is correct.");
        await shutdown("channel not found");
        return;
    }
    if (channel.type !== 2 && channel.type !== "GUILD_VOICE") { // ChannelType.GuildVoice = 2
        console.error(`❌ Channel is not a voice channel: ${channel.type}`);
        await shutdown("not a voice channel");
        return;
    }
    console.log(`📍 Voice Channel: ${channel.name} (${channel.id})`);

    // Join voice channel using @discordjs/voice
    // Note: discord.js-selfbot-v13 provides voiceAdapterCreator on Guild
    console.log("🔗 Joining voice channel...");
    try {
        voiceConnection = joinVoiceChannel({
            channelId: channel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: true,
            selfMute: false,
        });
        console.log("🔗 Voice connection initiated, waiting for ready state...");
    } catch (err) {
        console.error("❌ Failed to create voice connection:", err.message);
        await shutdown("voice connection creation failed");
        return;
    }

    // Voice connection status logging
    voiceConnection.on(VoiceConnectionStatus.Connecting, () => logVoiceStatus("Connecting"));
    voiceConnection.on(VoiceConnectionStatus.Ready, () => logVoiceStatus("Ready"));
    voiceConnection.on(VoiceConnectionStatus.Signalling, () => logVoiceStatus("Signalling"));
    voiceConnection.on(VoiceConnectionStatus.Disconnected, (oldState, newState) => {
        logVoiceStatus("Disconnected", oldState, newState);
        console.log(`   Reason: ${newState.reason}`);
    });
    voiceConnection.on(VoiceConnectionStatus.Destroyed, () => logVoiceStatus("Destroyed"));

    // Voice connection error handling
    voiceConnection.on("error", (err) => {
        console.error("❌ Voice connection error:", err.message);
    });

    // Wait for voice connection to be ready
    const { entersState } = require("@discordjs/voice");
    try {
        await entersState(voiceConnection, VoiceConnectionStatus.Ready, 20000);
        console.log("✅ Voice connection ready!");
    } catch (err) {
        console.error("❌ Voice connection failed to reach Ready state:", err.message);
        await shutdown("voice connection timeout");
        return;
    }

    // Create audio player
    audioPlayer = createAudioPlayer();
    console.log("🎵 Audio player created");

    // Audio player status logging
    audioPlayer.on(AudioPlayerStatus.Playing, () => logPlayerStatus("Playing"));
    audioPlayer.on(AudioPlayerStatus.Buffering, () => logPlayerStatus("Buffering"));
    audioPlayer.on(AudioPlayerStatus.Paused, () => logPlayerStatus("Paused"));
    audioPlayer.on(AudioPlayerStatus.Idle, () => logPlayerStatus("Idle"));
    audioPlayer.on(AudioPlayerStatus.AutoPaused, () => logPlayerStatus("AutoPaused"));

    // Audio player error handling
    audioPlayer.on("error", (err) => {
        console.error("❌ Audio player error:", err.message);
    });

    // Spawn ffmpeg to decode audio to raw PCM (s16le, 48kHz, stereo)
    console.log("🎬 Spawning ffmpeg...");
    ffmpegProcess = spawn("ffmpeg", [
        "-i", resolvedAudioPath,
        "-f", "s16le",
        "-ar", "48000",
        "-ac", "2",
        "pipe:1"
    ], {
        stdio: ["ignore", "pipe", "inherit"]
    });

    ffmpegProcess.on("error", (err) => {
        console.error("❌ Failed to spawn ffmpeg:", err.message);
        console.error("   Make sure ffmpeg is installed and in PATH.");
        shutdown("ffmpeg spawn failed");
    });

    ffmpegProcess.on("close", (code) => {
        console.log(`🎬 ffmpeg exited with code ${code}`);
        if (code !== 0 && code !== null) {
            console.error("❌ ffmpeg exited with error");
        }
    });

    // Create audio resource from ffmpeg stdout
    console.log("📦 Creating audio resource...");
    const audioResource = createAudioResource(ffmpegProcess.stdout, {
        inputType: StreamType.Raw,
    });

    audioResource.playStream.on("error", (err) => {
        console.error("❌ Audio resource stream error:", err.message);
    });

    // Subscribe voice connection to audio player
    console.log("🔗 Subscribing voice connection to audio player...");
    const subscription = voiceConnection.subscribe(audioPlayer);
    if (!subscription) {
        console.error("❌ Failed to subscribe voice connection to audio player");
        await shutdown("subscription failed");
        return;
    }
    console.log("✅ Subscription established");

    // Play the audio resource
    console.log("▶️  Starting playback...");
    audioPlayer.play(audioResource);

    // Start duration timer
    startDurationTimer();

    console.log("");
    console.log("✅ Spike running! Audio should now be playing in the voice channel.");
    console.log("   Press Ctrl+C to stop and clean up.");
    console.log("");
    console.log("   Criteria to verify manually:");
    console.log("   1. Audio is clear and audible in the voice channel");
    console.log("   2. Playback continues for 30+ minutes without cuts/desync");
    console.log("   3. (For handoff test) Switch to Lavalink and back - gap < 3s");
    console.log("   4. (For rejoin test) Disconnect bot from VC, then rejoin - audio resumes");
    console.log("");
});

// Client error handling
client.on("error", (err) => {
    console.error("❌ Discord client error:", err.message);
});

// Login
console.log("🔐 Logging in to Discord...");
client.login(TOKEN).catch((err) => {
    console.error("❌ Login failed:", err.message);
    process.exit(1);
});