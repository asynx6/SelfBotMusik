"use strict";

/**
 * SelfBotMusik — Lavalink v4 (Poru) + Web Dashboard (modular).
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

auth.seedDefaultUser();

function RuntimeSnapshot() { return runtimeMod.snapshot(); }

const client = discordMod.createClient();
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
    if (!stateMod.State.botReady || !stateMod.State.connected) return;
    if (reconnectAttempts >= MAX_RECONNECTS) {
        console.warn(`⚠️  Auto-rejoin aborted (${MAX_RECONNECTS} attempts): ${reason}`);
        return;
    }
    reconnectAttempts++;
    console.log(`🔧 Auto-rejoin VC attempt #${reconnectAttempts} (${reason})`);
    try {
        await leaveVC(true);
        await new Promise((r) => setTimeout(r, 800));
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

async function joinVC(guildId, channelId) {
    if (!guildId || !channelId) {
        throw new Error("guildId and channelId are required to join a voice channel");
    }
    if (!client.user?.id && client.ws?.status !== 0) {
        await new Promise((res) => client.once("ready", res));
    }
    if (!poru.isActivated) {
        // Defensive: someone called joinVC before ensurePoru finished. Run it now.
        try { await ensurePoru(); } catch (e) {
            throw new Error("Poru not ready: " + e.message);
        }
    }
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
        // (Player creation log moved into poru.on("playerCreate") below.)
    } else if (player.voiceChannel !== channelId) {
        player.voiceChannel = channelId;
    }
    // Connect properly: send the VOICE_STATE_UPDATE packet + mark connected.
    if (typeof player.connect === "function") {
        player.connect({ guildId, voiceChannel: channelId, deaf: true, mute: false });
    }
    stateMod.patch({ voiceConnected: true, voiceChannelId: channelId, guildId, lastError: null });
    console.log(`📥 Join VC → ${channelId} (${guildId})`);
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
        try { guild = client.guilds.resolve(guildId); } catch {}
    }
    if (!guild) {
        const e = new Error(`Bot is not in server with ID "${guildId}" — invite the account first`);
        e.code = "NOT_IN_GUILD";
        return Promise.reject(e);
    }
    const me = guild.members?.cache?.get?.(client.user.id) || guild.members?.me;
    if (me && me.voice && me.voice.channelId && me.voice.channelId === channelId) {
        // Already in this channel — fine.
    } else if (me && me.permissions && typeof me.permissions.has === "function") {
        // Voice permission flag for selfbots = CONNECT + SPEAK.
        if (!me.permissions.has(["CONNECT", "VIEW_CHANNEL"])) {
            const e = new Error(`Missing permission to join a voice channel in "${guild.name}"`);
            e.code = "NO_PERMISSION";
            return Promise.reject(e);
        }
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

async function leaveVC(force = false) {
    const rt = RuntimeSnapshot();
    const player = poru.players.get(rt.guildId);
    const isPlaying = !!(stateMod.State.playing && stateMod.State.playing.encoded);
    if (!force && isPlaying) {
        throw new Error("A track is playing — Stop first before disconnecting (use force=true to override)");
    }
    if (player) {
        try { player.queue.length = 0; } catch {}
        try { await player.stop(); } catch {}
        try { await player.destroy(); } catch {}
    }
    stateMod.patch({ voiceConnected: false, playing: null, queue: [], paused: false, position: 0 });
    console.log(`🎧 Leave VC (force=${force})`);
    broadcastNow();
}

function syncStateFromPlayer() {
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

const ctx = {
    RuntimeSnapshot,
    ensurePoru,
    markPoruDirty,
    removePoruNode,
    tryReconnectVC,
    resetReconnects,
    joinVC,
    leaveVC,
    probePermissions,
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
});

const { server } = webMod.buildServer(ctx);
server.listen(WEB_PORT, () => {
    console.log(`🌐 Dashboard ready on http://localhost:${WEB_PORT}`);
});

setInterval(() => stateMod.tick(ctx.getPlayer), 500);

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