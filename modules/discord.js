"use strict";

const { Client } = require("discord.js-selfbot-v13");
const runtimeMod = require("./runtime");

function createClient() {
    return new Client({ checkUpdate: false });
}

// Re-bind safety events: voice state drops, guild/channel deletion, shard
// reconnects. ctx exposes: State, patch(), tryReconnectVC(), resetReconnects().
// We deliberately use runtimeMod.Runtime (always-current) instead of a
// snapshot at wire-time — Settings changes are reflected immediately.
function wireSafetyEvents(client, ctx) {
    // Voice state changed for the bot.
    client.on("voiceStateUpdate", (oldState, newState) => {
        if (newState && newState.id === client.user.id) {
            const wasConn = oldState.channelId != null;
            const isConn = newState.channelId != null;
            if (wasConn && !isConn) {
                console.warn(`⚠️  Bot dropped out of VC (was: ${oldState.channelId})`);
                ctx.patch({ voiceConnected: false });
                ctx.tryReconnectVC("voice state dropped");
            } else if (isConn) {
                ctx.patch({ voiceConnected: true });
                ctx.resetReconnects();
            }
        }
    });

    client.on("channelDelete", (channel) => {
        const current = runtimeMod.Runtime.channelId;
        if (channel.id === current) {
            console.warn(`⚠️  Voice channel ${channel.name} deleted`);
            ctx.patch({ voiceConnected: false, lastError: "Voice channel deleted" });
            ctx.tryReconnectVC("channel deleted");
        }
    });

    client.on("guildDelete", (guild) => {
        const current = runtimeMod.Runtime.guildId;
        if (guild.id === current) {
            console.warn(`⚠️  Bot removed from guild ${guild.name}`);
            ctx.patch({
                botReady: false,
                voiceConnected: false,
                lastError: "Bot is no longer in this guild",
                playing: null,
                queue: [],
            });
            try { ctx.tryReconnectVC("guild deleted"); } catch {}
        }
    });

    client.on("error", (err) => {
        console.error("❌ Discord client error:", err.message);
        ctx.patch({ lastError: "Discord client error: " + err.message });
    });

    client.on("shardDisconnect", (closeEvent, shardId) => {
        console.warn(`⚠️  WS shard disconnected (shard ${shardId}): ${closeEvent?.code}`);
    });
    client.on("shardResume", (shardId, replayed) => {
        console.log(`📶 WS shard resumed (shard ${shardId}, replayed ${replayed})`);
        setTimeout(() => {
            if (ctx.State.botReady && !ctx.State.voiceConnected) {
                ctx.tryReconnectVC("WS resumed");
            }
        }, 1500);
    });
}

module.exports = { createClient, wireSafetyEvents };
