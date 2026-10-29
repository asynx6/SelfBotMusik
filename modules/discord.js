"use strict";

const { Client } = require("discord.js-selfbot-v13");
const runtimeMod = require("./runtime");

function createClient() {
    return new Client({ checkUpdate: false });
}

// Re-bind safety events: voice state drops, guild/channel deletion, shard
// reconnects. ctx exposes: State, patch(), tryReconnectVC(), resetReconnects(),
// intentionalDisconnect.
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
                if (ctx.intentionalDisconnect) {
                    ctx.intentionalDisconnect = false;
                    console.log("ℹ️  Intentional disconnect — skipping auto-rejoin");
                } else if (typeof ctx.tryReconnectVC === "function") {
                    ctx.tryReconnectVC("voice state dropped");
                }
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

    // Chat music request listener: "@bot what if i call" or "@bot song title"
    client.on("messageCreate", async (message) => {
        try {
            // Check if feature is enabled in runtime
            if (!runtimeMod.Runtime.chatRequestsEnabled) return;

            // Ignore messages from the bot itself
            if (message.author.id === client.user?.id) return;

            // Only respond in guild
            if (!message.guild) return;

            // Only respond if the bot is mentioned
            const isMentioned = message.mentions?.users?.has(client.user?.id);
            if (!isMentioned) return;

            // Extract the query by stripping the bot mention (<@!id> or <@id>)
            let content = message.content.replace(new RegExp(`<@!?${client.user?.id}>`, "g"), "").trim();
            if (!content) return;

            console.log(`💬 Discord chat music request from ${message.author.tag}: "${content}"`);

            // Execute play request if enqueue or searchTracks is available
            if (typeof ctx.handleChatRequest === "function") {
                const res = await ctx.handleChatRequest(content, message.author.tag);
                if (res?.ok) {
                    try {
                        await message.reply(`🎵 Memutar: **${res.title || content}**`);
                    } catch {}
                } else if (res?.error) {
                    try {
                        await message.reply(`⚠️ Gagal: ${res.error}`);
                    } catch {}
                }
            }
        } catch (e) {
            console.error("chat music request error:", e.message);
        }
    });
}

module.exports = { createClient, wireSafetyEvents };
