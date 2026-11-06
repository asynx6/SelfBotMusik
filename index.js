"use strict";

/**
 * SelfBotMusic — Lavalink v4 (Poru) + Web Dashboard (modular).
 * ---------------------------------------------------------------
 * Boot secrets only in `.env` → TOKEN_USER + WEB_PORT.
 * All runtime config (Lavalink, Guild/Channel, JWT secret, user
 * password hash, login attempts) lives in `data/app.sqlite`.
 * The bot signs into Discord on startup but does NOT auto-connect
 * to Lavalink / voice — connect is manual from the dashboard.
 */

require("dotenv").config();

const TOKEN = process.env.TOKEN_USER;
const WEB_PORT = Number(process.env.WEB_PORT || 3434);

if (!TOKEN) {
    console.error("❌ Missing TOKEN_USER in .env. Add it and try again.");
    process.exit(1);
}

// Process-level safety nets. Lavalink / Poru sometimes throws inside
// timers or async microtasks. We log and keep running instead of dying.
process.on("uncaughtException", (err) => {
    console.error("⚠️  uncaughtException:", err?.message || err);
});
process.on("unhandledRejection", (reason) => {
    console.error("⚠️  unhandledRejection:", reason?.message || reason);
});

const db = require("./modules/database");

const cfgMod = require("./modules/config");
const runtimeMod = require("./modules/runtime");
const auth = require("./modules/auth");
const stateMod = require("./modules/state");
const discordMod = require("./modules/discord");
const poruMod = require("./modules/poru-manager");
const playerMod = require("./modules/player");
const webMod = require("./modules/webserver");
const library = require("./modules/library");
const binaries = require("./modules/binaries");
const downloads = require("./modules/downloads");
const uploads = require("./modules/uploads");
const playlists = require("./modules/playlists");
const likes = require("./modules/likes");
const history = require("./modules/history");
const recommendations = require("./modules/recommendations");
const { createAutoplayService, normaliseKey } = require("./modules/autoplay");
const PlayerController = require("./modules/player-controller");
const { LavalinkEngine } = require("./modules/engines/lavalink");
const { LocalEngine } = require("./modules/engines/local");
const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus } = require("@discordjs/voice");

// --- Shared local voice connection -------------------------------------------
// Offline (local) playback connects to voice through @discordjs/voice, while
// Lavalink (Poru) uses the very same underlying connection registry. The
// Connect/Disconnect buttons AND the LocalEngine must share ONE connection per
// guild, otherwise the bot opens a second, conflicting session in the channel.
// We keep that single connection here and hand it to the LocalEngine factory.
let localVoiceConnection = null;

/**
 * Wait until a voice connection is actually usable.
 *
 * `joinVoiceChannel()` returns immediately in the "signalling" state; the
 * connection only becomes "ready" after Discord answered with a voice server
 * update. Playing before that point means ffmpeg decodes into a connection
 * that never transmits — silence with no error. Waiting turns that into an
 * explicit, reportable failure.
 */
async function waitForVoiceReady(conn, timeoutMs = 15000) {
    if (!conn) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const status = conn.state?.status;
        if (status === VoiceConnectionStatus.Ready) return true;
        if (status === VoiceConnectionStatus.Destroyed) return false;
        if (status === VoiceConnectionStatus.Disconnected) {
            // It may still be recovering (rejoin). Give it a moment.
            await new Promise((r) => setTimeout(r, 250));
            continue;
        }
        await new Promise((r) => setTimeout(r, 150));
    }
    return conn.state?.status === VoiceConnectionStatus.Ready;
}

function connectLocalVoice(guildId, channelId) {
    if (!guildId || !channelId) return null;
    let conn = getVoiceConnection(guildId);
    if (conn && conn.joinConfig?.channelId === channelId) {
        localVoiceConnection = conn;
        return conn;
    }
    // The bridge's adapter creator is used instead of guild.voiceAdapterCreator:
    // it delivers the gateway packets in the order @discordjs/voice needs, so
    // the UDP socket actually gets created.
    conn = joinVoiceChannel({
        guildId,
        channelId,
        adapterCreator: voiceBridge.adapterCreator(guildId),
        selfDeaf: true,
        selfMute: false
    });
    localVoiceConnection = conn;
    watchVoiceConnection(conn, guildId);
    return conn;
}

// Surface the connection lifecycle in the console. Without this a voice
// handshake that dies is completely invisible: the bot sits in the channel
// playing silence.
function watchVoiceConnection(conn, guildId) {
    if (!conn || typeof conn.on !== "function") return;
    conn.on("stateChange", (oldState, newState) => {
        console.log(`[voice] ${oldState.status} -> ${newState.status} (guild ${guildId})`);
        if (newState.reason !== undefined && newState.reason !== null) {
            console.warn(`[voice] alasan: ${newState.reason} (${VoiceConnectionStatus[newState.reason] || "tidak diketahui"})`);
        }
    });
    conn.on("error", (e) => {
        console.error(`[voice] ❌ error koneksi voice: ${e?.message || e}`);
    });
}

function disconnectLocalVoice() {
    try {
        const conn = localVoiceConnection || getVoiceConnection(RuntimeSnapshot().guildId);
        if (conn && typeof conn.destroy === "function") conn.destroy();
    } catch (e) {
        console.warn("[voice] local voice disconnect:", e.message);
    }
    localVoiceConnection = null;
}

auth.seedDefaultUser();

// External binary resolution — bundled ./bin wins over configured paths so a
// Pterodactyl container needs no absolute path setup. See modules/binaries.js.
{
    const bundled = binaries.bundledStatus();
    const ffmpegPath = binaries.resolveFfmpegPath({ dbValue: db.getSetting("ffmpeg_path") });
    const ytdlpPath = binaries.resolveYtdlpPath({ dbValue: db.getSetting("ytdlp_path") });
    console.log(`🎬 ffmpeg : ${ffmpegPath}${bundled.ffmpeg.present ? " (bundled)" : ""}`);
    console.log(`⬇️  yt-dlp : ${ytdlpPath}${bundled.ytdlp.present ? " (bundled)" : ""}`);
    if (!bundled.ffmpeg.present && !bundled.ytdlp.present) {
        console.log("   ℹ️  No bundled binaries found. Run `npm run setup:bin` for a self-contained install.");
    }
}

function RuntimeSnapshot() { return runtimeMod.snapshot(); }

const client = discordMod.createClient();
// Install the voice bridge BEFORE any voice connection is attempted: it
// re-orders the gateway packets so @discordjs/voice actually starts its UDP
// socket. See modules/voice-bridge.js for the full explanation.
const voiceBridge = require("./modules/voice-bridge").installVoiceBridge(client);
const poru = poruMod.createPoru(client);
poruMod.wirePoruEvents(poru, stateMod.patch);

let poruInitPromise = null;
let poruDirty = false;

async function ensurePoru() {
    const rt = RuntimeSnapshot();
    if (!rt.lavaHost || !rt.lavaPass) {
        const e = new Error("Set Lavalink host/password in Settings first");
        e.code = "MISSING_LAVALINK_CONFIG";
        throw e;
    }
    if (poruDirty) poruInitPromise = null;
    if (!poruInitPromise) {
        poruInitPromise = (async () => {
            // Teardown any previous state cleanly.
            try { await poru.removeNode("main"); } catch {}
            // CRITICAL: call init() FIRST. It sets this.userId (from
            // client.user.id) and wires the library-specific voice packet
            // listener. Without these, Node.connect throws "No user id
            // found" when we addNode().
            if (!poru.isActivated) await poru.init();
            // Wait one tick for client.user to be populated.
            if (!poru.userId && client.user?.id) poru.userId = client.user.id;
            await poru.addNode({
                name: "main",
                host: rt.lavaHost,
                port: rt.lavaPort,
                password: rt.lavaPass,
                secure: rt.lavaSecure,
            });
            poruDirty = false;
        })();
    }
    return poruInitPromise;
}
function markPoruDirty() { poruDirty = true; }
async function removePoruNode() {
    try { await poru.removeNode("main"); } catch {}
}

let reconnectAttempts = 0;
const MAX_RECONNECTS = 5;
async function tryReconnectVC(reason) {
    // `connected` only describes the Lavalink node. Gating rejoin on it made
    // offline/local playback unrecoverable after a voice drop.
    if (!stateMod.State.botReady || intentionalDisconnect) return;
    const target = RuntimeSnapshot();
    if (!target.guildId || !target.channelId) return;
    if (reconnectAttempts >= MAX_RECONNECTS) {
        console.warn(`⚠️  Auto-rejoin aborted (${MAX_RECONNECTS} attempts): ${reason}`);
        return;
    }
    reconnectAttempts++;
    console.log(`🔧 Auto-rejoin VC attempt #${reconnectAttempts} (${reason})`);
    try {
        // Engine-aware rejoin: LocalEngine owns its own voice connection
        // (via @discordjs/voice) — just re-run its connection setup.
        // LavalinkEngine rejoins through Poru (leaveVC + joinVC below).
        const eng = playerController?.currentEngine;
        if (playerController && playerController.currentEngineType === "local" && eng?._ensureVoiceConnection) {
            await eng._ensureVoiceConnection();
            reconnectAttempts = 0;
            console.log("✅ Auto-rejoin successful (LocalEngine)");
            return;
        }
        // Rejoin WITHOUT leaveVC(): it calls playerController.disconnect(),
        // which destroys the engine and clears the whole queue. A dropped
        // voice session must not wipe what the user queued.
        await new Promise((r) => setTimeout(r, 400));
        const rt = RuntimeSnapshot();
        if (!rt.guildId || !rt.channelId) return;
        await joinVC(rt.guildId, rt.channelId);
        reconnectAttempts = 0;
        console.log("✅ Auto-rejoin successful");
    } catch (e) {
        console.error(`❌ Auto-rejoin #${reconnectAttempts} failed:`, e.message);
        setTimeout(() => tryReconnectVC(reason), 1000 * Math.pow(2, reconnectAttempts - 1));
    }
}
function resetReconnects() { reconnectAttempts = 0; }

async function joinVC(guildId, channelId, { lavalinkUp } = {}) {
    if (!guildId || !channelId) {
        throw new Error("guildId and channelId are required to join a voice channel");
    }
    if (!client.user?.id && client.ws?.status !== 0) {
        await new Promise((res) => client.once("ready", res));
    }

    const rt = RuntimeSnapshot();
    // Callers that already probed Lavalink can pass the result; otherwise fall
    // back to the live node state instead of trusting the config being present.
    const hasLavalink = lavalinkUp !== undefined
        ? lavalinkUp
        : (!!(rt.lavaHost && rt.lavaPass) && !!stateMod.State.connected);

    // Poru (Lavalink) voice connection — OPTIONAL. A missing Lavalink node must
    // not block joining, because local/offline playback uses @discordjs/voice.
    if (hasLavalink) {
        try {
            if (!poru.isActivated) await ensurePoru();
            if (!poru.userId && client.user?.id) poru.userId = client.user.id;
            let player = poru.players.get(guildId);
            if (!player) {
                try {
                    player = await poru.createConnection({
                        guildId,
                        voiceChannel: channelId,
                        textChannel: channelId,
                        selfDeaf: true,
                        selfMute: false,
                    });
                } catch (e) {
                    // Fallback to manual createPlayer if createConnection misbehaves.
                    console.warn("createConnection fallback:", e.message);
                    player = await poru.createPlayer({
                        guildId,
                        voiceChannel: channelId,
                        textChannel: channelId,
                        selfDeaf: true,
                        selfMute: false,
                    });
                }
            } else if (player.voiceChannel !== channelId) {
                player.voiceChannel = channelId;
            }
            // Connect properly: send the VOICE_STATE_UPDATE packet + mark connected.
            if (typeof player.connect === "function") {
                player.connect({ guildId, voiceChannel: channelId, deaf: true, mute: false });
            }
        } catch (e) {
            console.warn("poru join skipped (Lavalink unavailable):", e.message);
        }
    }

    // ONLY ONE voice owner per guild. Opening a second @discordjs/voice
    // session here would send another VOICE_STATE_UPDATE, invalidating the
    // Lavalink session Poru just opened — Lavalink then accepts tracks but
    // never transmits them (position frozen at 0). So the local connection is
    // opened only when Lavalink did NOT actually take ownership of voice —
    // a configured-but-unreachable Lavalink still needs the local path.
    const needLocalVoice = !hasLavalink || !stateMod.State.connected;
    const voiceConn = needLocalVoice ? connectLocalVoice(guildId, channelId) : null;
    if (voiceConn) {
        // Non-blocking readiness check: a handshake that never completes is
        // reported in the log instead of silently producing silence.
        waitForVoiceReady(voiceConn, 12000).then((ok) => {
            if (!ok) {
                console.warn(
                    `[voice] ⚠️  Koneksi voice untuk guild ${guildId} belum siap `
                    + `(status: ${voiceConn.state?.status}) — playback offline bisa jadi tidak bersuara`
                );
            }
        }).catch(() => {});
    }

    stateMod.patch({ voiceConnected: true, voiceChannelId: channelId, guildId, lastError: null });
    console.log(`📥 Join VC → ${channelId} (${guildId})${hasLavalink ? " [poru]" : " [local]"}`);
    broadcastNow();
}

// Pre-join safety probe: confirms guild exists, channel exists, channel is a
// voice channel, bot is in that guild, and the bot has permission to join.
function probePermissions(guildId, channelId) {
    if (!guildId || !channelId) {
        const e = new Error("Missing guildId or channelId — fill them in Settings");
        e.code = "MISSING_IDS";
        return Promise.reject(e);
    }
    if (!client.user?.id) {
        const e = new Error("Discord bot is not ready yet");
        e.code = "BOT_NOT_READY";
        return Promise.reject(e);
    }
    // Try to fetch from cache or REST. discord.js-selfbot caches commonly.
    let guild = client.guilds.cache.get(guildId);
    if (!guild) {
        try { guild = client.guilds.resolve(guildId); } catch (e) {
            console.warn(`guild.resolve(${guildId}) failed:`, e.message);
        }
    }
    if (!guild) {
        const e = new Error(`Bot is not in server with ID "${guildId}" — invite the account first`);
        e.code = "NOT_IN_GUILD";
        return Promise.reject(e);
    }
    const me = guild.members?.cache?.get?.(client.user.id) || guild.members?.me;
    if (me && me.voice && me.voice.channelId && me.voice.channelId === channelId) {
        // Already in this channel — fine.
    } else if (me) {
        // Permission check: selfbot-v13 permissions may behave differently than
        // regular discord.js. We check CONNECT only (VIEW_CHANNEL is implicit
        // for selfbots). Admin bypass: if the user has ADMINISTRATOR, skip check.
        let canConnect = true;
        try {
            if (me.permissions && typeof me.permissions.has === "function") {
                if (me.permissions.has("ADMINISTRATOR")) {
                    console.log(`[probe] Admin bypass for guild ${guild.name}`);
                } else {
                    // Check CONNECT only — selfbots always have VIEW_CHANNEL
                    // where they're a member, and has(array) is unreliable.
                    canConnect = me.permissions.has("CONNECT");
                }
            }
            // If permissions object doesn't exist or has() isn't a function,
            // allow through — selfbots usually have the needed perms when
            // they're in a guild. The actual join attempt will surface errors.
        } catch (permErr) {
            // If the permissions check itself throws, allow through — the
            // real error will surface during voice connection.
            console.warn(`[probe] Permissions check threw (allowing through): ${permErr.message}`);
        }
        if (!canConnect) {
            console.warn(`[probe] No CONNECT permission in guild "${guild.name}"`);
            const e = new Error(`Missing permission to join a voice channel in "${guild.name}"`);
            e.code = "NO_PERMISSION";
            return Promise.reject(e);
        }
    } else {
        console.warn(`[probe] Could not resolve self-member in guild "${guild.name}" — allowing through`);
    }
    let channel = guild.channels.cache.get(channelId);
    if (!channel) {
        try { channel = client.channels.cache.get(channelId); } catch {}
    }
    if (!channel) {
        const e = new Error(`Voice channel with ID "${channelId}" not found in guild "${guild.name}"`);
        e.code = "CHANNEL_MISSING";
        return Promise.reject(e);
    }
    if (typeof channel.type !== "undefined") {
        // Guild voice = 2 in discord.js.
        if (channel.type !== 2 && channel.type !== "GUILD_VOICE") {
            const e = new Error(`Channel "${channel.name}" is not a voice channel`);
            e.code = "NOT_VOICE_CHANNEL";
            return Promise.reject(e);
        }
    }
    return { guild, channel, me };
}

let intentionalDisconnect = false;

async function leaveVC(force = false, intentional = false) {
    const rt = RuntimeSnapshot();
    const isPlaying = !!(stateMod.State.playing && stateMod.State.playing.encoded);
    if (!force && isPlaying) {
        throw new Error("A track is playing — Stop first before disconnecting (use force=true to override)");
    }
    if (intentional) intentionalDisconnect = true;

    // 1) The controller's active engine (LocalEngine for offline playback) owns
    //    the REAL voice connection. Destroying it is what actually makes the bot
    //    leave the channel — the poru player below is only the Lavalink half.
    if (playerController) {
        try { await playerController.disconnect(); } catch (e) {
            console.warn("controller disconnect:", e.message);
        }
    }

    // 2) Poru (Lavalink) player, if any.
    const player = poru.players.get(rt.guildId);
    if (player) {
        try { player.queue.length = 0; } catch {}
        try { await player.stop(); } catch {}
        try { await player.destroy(); } catch {}
    }

    // 3) The shared @discordjs/voice connection used by Connect + local playback.
    disconnectLocalVoice();

    stateMod.patch({ voiceConnected: false, playing: null, queue: [], paused: false, position: 0 });
    console.log(`🎧 Leave VC (force=${force})`);
    broadcastNow();
}

function syncStateFromPlayer() {
    if (playerController) {
        const snap = playerController.getSnapshot();
        stateMod.patch({
            playing: snap.playing || null,
            queue: Array.isArray(snap.queue) ? snap.queue : [],
            paused: !!snap.paused,
            volume: Number.isFinite(snap.volume) ? snap.volume : 100,
            loop: Number.isFinite(snap.loop) ? snap.loop : 0,
            position: Number.isFinite(snap.position) ? snap.position : 0,
            // Playback failures (e.g. a track with no usable engine) reach the
            // dashboard here. `lastError` stays reserved for system errors.
            playbackError: snap.lastError || null,
        });
        return;
    }
    const rt = RuntimeSnapshot();
    const player = poru.players.get(rt.guildId);
    const queue = [];
    if (player?.currentTrack) queue.push(serializeTrack(player.currentTrack, true));
    if (Array.isArray(player?.queue)) for (const t of player.queue) queue.push(serializeTrack(t, false));
    stateMod.patch({
        playing: queue[0] || null,
        queue,
        paused: !!player?.isPaused,
        position: player?.position || 0,
    });
}
function serializeTrack(t, isCurrent) {
    const info = t?.info || {};
    return {
        title: info.title || "Unknown",
        author: info.author || "Unknown",
        duration: info.length || 0,
        uri: info.uri || "",
        thumbnail: info.artworkUrl || (info.identifier ? `https://i.ytimg.com/vi/${info.identifier}/hqdefault.jpg` : ""),
        encoded: t?.track || "",
        requester: t?.requester?.tag || t?.requester || "—",
        isCurrent,
    };
}
function stopAll() { return playerMod.stopAll(poru, runtimeMod.Runtime); }
function broadcastNow() { stateMod.emitter.emit("change"); }

// === Unified PlayerController (task 9) ===
let playerController = null;
try {
    playerController = new PlayerController({
        library,
        // Async factory: LavalinkEngine.destroy() kills the Poru player, so
        // before re-creating the engine we must restore the voice connection.
        createLavalinkEngine: async () => {
            await ensurePoru();
            const g = runtimeMod.Runtime.guildId;
            if (g && runtimeMod.Runtime.channelId && !poru.players.get(g)) {
                await joinVC(g, runtimeMod.Runtime.channelId);
            }
            return new LavalinkEngine({ poru, guildId: g });
        },
        createLocalEngine: ({ channelId } = {}) => new LocalEngine({
            client,
            guildId: runtimeMod.Runtime.guildId,
            channelId: channelId || runtimeMod.Runtime.channelId,
            ffmpegPath: binaries.resolveFfmpegPath({ dbValue: db.getSetting("ffmpeg_path") }),
            dataDir: db.DATA_DIR,
            // Reuse the connection the Connect button opened (if any) so playback
            // doesn't open a second, competing session in the same channel.
            voiceConnection: getVoiceConnection(runtimeMod.Runtime.guildId) || null,
        }),
        db: db.db,
        dataDir: db.DATA_DIR,
        getVoiceTarget: () => ({ guildId: runtimeMod.Runtime.guildId, channelId: runtimeMod.Runtime.channelId }),
        // Engine handoff: controller tears down the old engine — mark the
        // disconnect intentional so safety auto-rejoin doesn't interfere.
        onIntentionalDisconnect: (v) => { intentionalDisconnect = !!v; },
        isLavalinkReady: () => !!stateMod.State.connected,
    });
    // The controller is the source of truth while it owns playback. Without
    // syncing here the WebSocket kept broadcasting a stale State (playing:null),
    // so the dashboard greyed out play/skip even though audio was running.
    playerController.on("state", () => syncStateFromPlayer());
    // Autoplay: similar candidates are prepared while a track plays, so the
    // next one is ready the moment the explicit queue runs out. An explicitly
    // queued track always takes priority (see PlayerController.next).
    const autoplay = createAutoplayService({
        isLavalinkReady: () => !!stateMod.State.connected,
        getActiveKeys: () => playerController.queue.map((i) => normaliseKey(i.track)),
        getLibraryCandidates: async (seed) => recommendations.getRecommendations(
            seed ? { id: seed.id, title: seed.title, artist: seed.artist || seed.author } : null,
            { limit: 20 }
        ),
        searchOnline: async (query) => {
            const { tracks } = await playerMod.searchTracksAuto(poru, query, "Autoplay", ["ytmsearch"]);
            return (tracks || []).map((t) => ({
                title: t.info?.title || "Unknown",
                artist: t.info?.author || "",
                uri: t.info?.uri || "",
                identifier: t.info?.identifier || "",
                source_key: t.info?.sourceName && t.info?.identifier
                    ? `${t.info.sourceName}:${t.info.identifier}` : "",
                encoded: t.track || "",
                duration_ms: t.info?.length || 0,
                thumbnail: t.info?.artworkUrl || "",
                source_type: "lavalink",
            })).filter((t) => t.title && t.title !== "Unknown");
        },
    });
    playerController.setAutoplayProvider((lastTrack) => autoplay.take(lastTrack));
    playerController.setAutoplayPrefetcher((seed) => {
        autoplay.notePlayed(seed);
        return autoplay.prepare(seed);
    });
} catch (e) {
    console.error("⚠️  PlayerController init failed, falling back to legacy player:", e.message);
    playerController = null;
}

const ctx = {
    RuntimeSnapshot,
    ensurePoru,
    markPoruDirty,
    removePoruNode,
    tryReconnectVC,
    resetReconnects,
    joinVC,
    leaveVC: (force) => leaveVC(force, true),
    internalLeaveVC: (force) => leaveVC(force, false),
    probePermissions,
    intentionalDisconnect: false,
    set intentionalDisconnect(v) { intentionalDisconnect = v; },
    get intentionalDisconnect() { return intentionalDisconnect; },
    syncStateFromPlayer,
    getPlayer: () => { try { return poru.players.get(RuntimeSnapshot().guildId) || null; } catch { return null; } },
    enqueue: (q, r) => playerMod.enqueue(poru, q, r, ensurePoru, joinVC, runtimeMod.Runtime),
    skipTrack: () => playerMod.skipTrack(poru, runtimeMod.Runtime),
    stopAll,
    togglePause: () => playerMod.togglePause(poru, runtimeMod.Runtime),
    setVolume: (v) => playerMod.setVolume(poru, runtimeMod.Runtime, v),
    cycleLoop: () => playerMod.cycleLoop(poru, runtimeMod.Runtime),
    setLoop: (m) => playerMod.setLoop(poru, runtimeMod.Runtime, m),
    removeAt: (i) => playerMod.removeAt(poru, runtimeMod.Runtime, i),
    clearQueue: () => playerMod.clearQueue(poru, runtimeMod.Runtime),
    applyRuntimeConfig: (p) => runtimeMod.applyRuntimeConfig(p, {
        ensurePoru,
        leaveVC,
        joinVC,
        stopAll,
        getPlayer: () => poru.players.get(RuntimeSnapshot().guildId) || null,
        removePoruNode,
        markPoruDirty,
        State: stateMod.State,
        patch: stateMod.patch,
    }),
    State: stateMod.State,
    library,
    downloads,
    uploads,
    playlists,
    likes,
    history,
    recommendations,
    playerController,
    // Adapter: searchTracks returns Poru Track objects ({ track, info }) —
    // webserver/library expect plain info objects. Flatten + keep encoded for LavalinkEngine.
    searchTracks: async (query, requester) => {
        const tracks = await playerMod.searchTracks(poru, query, requester);
        return tracks.map((t) => ({ ...t.info, encoded: t.track, requester: t.requester }));
    },
};
ctx.wss = null;

poru.on("playerCreate", (player) => {
    console.log(`🎵 Player created for guild ${player.guildId}`);
});
poru.on("playerDestroy", (player) => {
    if (player.guildId === RuntimeSnapshot().guildId) {
        stateMod.patch({ playing: null, queue: [], paused: false, position: 0, voiceConnected: false });
        broadcastNow();
    }
});

poru.on("trackStart", (player, track) => {
    if (player.guildId !== runtimeMod.Runtime.guildId) return;
    stateMod.patch({ paused: false });
    syncStateFromPlayer();
    broadcastNow();
    console.log(`▶️  Now playing: ${track.info?.title || "?"}`);
});
poru.on("trackEnd", (player, track, data) => {
    if (player.guildId !== runtimeMod.Runtime.guildId) return;
    console.log(`⏹️  Track ended: ${data?.reason}`);
    syncStateFromPlayer();
    broadcastNow();
});
poru.on("trackStuck", (player, track, thresholdMs) => {
    if (player.guildId !== runtimeMod.Runtime.guildId) return;
    console.warn(`⚠️  Stuck: ${track.info?.title} (${thresholdMs}ms)`);
    player.skip().catch(() => {});
});
poru.on("trackError", (player, track, data) => {
    if (player.guildId !== runtimeMod.Runtime.guildId) return;
    console.error(`❌ Track exception:`, data?.exception?.message || data);
    player.skip().catch(() => {});
});

discordMod.wireSafetyEvents(client, {
    State: stateMod.State,
    patch: stateMod.patch,
    channelId: runtimeMod.Runtime.channelId,
    guildId: runtimeMod.Runtime.guildId,
    tryReconnectVC,
    resetReconnects,
    // Engine handoffs mark the flag via onIntentionalDisconnect (PlayerController);
    // genuine drops must still trigger auto-rejoin, so the getter stays plain.
    get intentionalDisconnect() { return intentionalDisconnect; },
    set intentionalDisconnect(v) { intentionalDisconnect = v; },
    handleChatRequest: async (query, requester) => {
        try {
            // Auto-source search: URLs pass through (Spotify/YouTube/SoundCloud);
            // plain titles try ytsearch then other configured sources.
            const extraSources = ["ytmsearch", "spsearch", "scsearch"].filter(Boolean);
            const { tracks, playlistName } = await playerMod.searchTracksAuto(
                poru, query, requester, extraSources
            );
            if (!tracks || !tracks.length) return { error: "Lagu tidak ditemukan" };
            for (const t of tracks) {
                try { library.upsertFromLavalink(t.info); } catch {}
            }
            // The DB row is metadata only. Carry the base64 Lavalink track from
            // the search result into the queue item, otherwise LavalinkEngine
            // has to re-resolve by title (and Poru may silently play nothing).
            const rows = tracks
                .map((t) => {
                    const row = library.findBySourceKey(`${t.info.sourceName}:${t.info.identifier}`);
                    return row ? { ...row, encoded: t.track || row.encoded || "" } : null;
                })
                .filter(Boolean);
            if (!rows.length) return { error: "Gagal menyimpan hasil pencarian" };

            let result = null;
            if (playerController) {
                result = await playerController.enqueue(rows, requester);
            } else {
                await ctx.enqueue(query, requester);
            }
            return {
                ok: true,
                title: rows[0]?.title || query,
                playlistName,
                count: rows.length,
                queued: !!result?.queued,
                playing: !!result?.playing,
                queuePosition: result?.queuePosition ?? null,
            };
        } catch (err) {
            return { error: err.message };
        }
    },
});

const { server } = webMod.buildServer(ctx);
server.listen(WEB_PORT, () => {
    console.log(`🌐 Dashboard ready on http://localhost:${WEB_PORT}`);
});

// Current playback position, whatever engine is driving it.
// The old ticker only asked Poru, so local (ffmpeg) playback always reported
// 0 and the progress bar never moved.
function currentPositionMs() {
    const engine = playerController?.currentEngine;
    if (engine && typeof engine.getPositionMs === "function") {
        try { return engine.getPositionMs() || 0; } catch { return 0; }
    }
    const poruPlayer = poru.players.get(RuntimeSnapshot().guildId);
    return typeof poruPlayer?.position === "number" ? poruPlayer.position : 0;
}

setInterval(() => stateMod.tick(() => ({ position: currentPositionMs() })), 500);

// Memory watchdog. One compact line per interval makes an OOM diagnosable
// from the panel console: a rising `ext` points at buffered sockets or
// native allocations, a rising `heap` points at retained JS objects.
// Set MEMORY_LOG_MS=0 to silence it.
const MEMORY_LOG_MS = Number(process.env.MEMORY_LOG_MS ?? 600000);
if (MEMORY_LOG_MS > 0) {
    const v8 = require("v8");
    const toMb = (bytes) => (bytes / 1048576).toFixed(0);
    setInterval(async () => {
        const mem = process.memoryUsage();
        const heap = v8.getHeapStatistics();
        const ws = ctx.wss?.clients?.size ?? 0;
        let diskFree = "n/a";
        try {
            const free = await library.freeDiskBytes();
            if (free !== null) diskFree = `${toMb(free)}MB`;
        } catch { /* statfs unavailable */ }
        console.log(
            `📊 mem rss=${toMb(mem.rss)}MB heap=${toMb(mem.heapUsed)}/${toMb(heap.heap_size_limit)}MB ` +
            `ext=${toMb(mem.external)}MB ab=${toMb(mem.arrayBuffers)}MB ` +
            `ws=${ws} queue=${stateMod.State.queue?.length ?? 0} disk_free=${diskFree}`
        );
    }, MEMORY_LOG_MS).unref();
}

client.once("ready", async () => {
    console.log(`🔥 Login OK: ${client.user.tag} (${client.user.id})`);
    stateMod.patch({ botReady: true });
    resetReconnects();

    console.log(`🌐 Dashboard → http://localhost:${WEB_PORT}`);
    const rt = RuntimeSnapshot();
    if (!rt.lavaHost || !rt.lavaPass) {
        console.log("⚠️  Lavalink host not configured. Open Settings → Connect to set it up.");
    } else if (!rt.guildId || !rt.channelId) {
        console.log("⚠️  Guild / Voice Channel not set. Open Settings → Connect to choose them.");
    } else {
        console.log("ℹ️  Settings complete. Click Connect in the dashboard when ready.");
    }
});

client.login(TOKEN).catch((e) => console.error(`❌ Login failed: ${e.message}`));

async function shutdown() {
    console.log("\n🛑 Shutting down…");
    try { await ctx.stopAll(false); } catch {}
    try { server.close(); } catch {}
    try { ctx.wss?.clients.forEach((c) => c.terminate()); } catch {}
    try { await client.destroy(); } catch {}
    try { db.db.close(); } catch {}
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const _rt0 = RuntimeSnapshot();
console.log(`📋 Boot: web=${WEB_PORT} | Lavalink ${_rt0.lavaHost || "(none)"} : ${_rt0.lavaPort} | default user=admin`);