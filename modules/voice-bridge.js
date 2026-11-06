"use strict";

/**
 * Voice bridge: discord.js-selfbot-v13  ⇄  @discordjs/voice v0.18
 * ---------------------------------------------------------------
 * Why this exists
 *
 * The project talks to Discord with `discord.js-selfbot-v13` (a v13 fork) but
 * plays audio through `@discordjs/voice` v0.18, which was written for
 * discord.js v14. The two sides agree on the adapter shape, but @discordjs/voice
 * has a hidden ordering requirement:
 *
 *   - `addServerPacket()`  → VOICE_SERVER_UPDATE (endpoint + token)
 *   - `addStatePacket()`   → VOICE_STATE_UPDATE  (session_id + user_id)
 *
 * …and ONLY `addServerPacket()` calls `configureNetworking()`. `addStatePacket()`
 * merely stores the packet and never retries. So if the server update arrives
 * first, `configureNetworking()` runs with `state === undefined`, returns early,
 * and the connection is stuck in `signalling` FOREVER:
 *
 *   - no UDP socket is ever created
 *   - no audio is ever transmitted
 *   - no error is raised anywhere
 *
 * The bot still shows up in the voice channel (the op-4 join packet went
 * through) and ffmpeg still happily decodes the file, which is exactly the
 * "bot nya ga nyanyi" symptom: everything looks fine, nothing is audible.
 *
 * Discord delivers those two packets in that order for user accounts, so we
 * cannot rely on the library's own bridge. This module intercepts the RAW
 * gateway payloads and re-delivers them in the order @discordjs/voice needs:
 * session packet first, server packet second.
 *
 * We also deliberately do NOT register into `client.voice.adapters`: the stock
 * bridge would deliver the packets in Discord's original order and undo the
 * re-ordering.
 */

const SHARD_READY = 0; // discord.js v13 `Status.READY`

function installVoiceBridge(client) {
    if (!client) throw new Error("installVoiceBridge requires a client");
    if (client.__sbmVoiceBridge) return client.__sbmVoiceBridge;

    /** guildId -> { state, server, timer } */
    const buffers = new Map();
    /** guildId -> @discordjs/voice methods object */
    const methodsByGuild = new Map();

    function deliver(guildId) {
        const buf = buffers.get(guildId);
        const methods = methodsByGuild.get(guildId);
        if (!buf || !methods) return;
        if (!buf.state || !buf.server) return;

        if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }
        buffers.delete(guildId);

        const state = buf.state;
        const server = buf.server;

        // ORDER IS THE WHOLE POINT: the session packet must be delivered first,
        // otherwise configureNetworking() never runs.
        try {
            methods.onVoiceStateUpdate(state);
            methods.onVoiceServerUpdate(server);
            console.log(`[voice] ✅ paket voice lengkap untuk guild ${guildId} — networking dimulai`);
        } catch (e) {
            console.error(`[voice] ❌ gagal mengirim paket voice: ${e.message}`);
        }
    }

    function bufferFor(guildId) {
        let buf = buffers.get(guildId);
        if (!buf) {
            buf = { state: null, server: null, timer: null };
            buffers.set(guildId, buf);
        }
        return buf;
    }

    // --- intercept the RAW gateway payloads -------------------------------
    const origServer = client.voice.onVoiceServer.bind(client.voice);
    client.voice.onVoiceServer = (payload) => {
        const guildId = payload.guild_id || payload.channel_id;
        if (guildId && methodsByGuild.has(guildId)) {
            const buf = bufferFor(guildId);
            buf.server = payload;
            deliver(guildId);
            if (!buf.state && !buf.timer) {
                // If the session packet never arrives we must NOT stay silent:
                // release the buffer and let the connection fail loudly.
                buf.timer = setTimeout(() => {
                    const b = buffers.get(guildId);
                    if (b && b.server && !b.state) {
                        console.warn(
                            `[voice] ⚠️  VOICE_STATE_UPDATE tidak diterima untuk guild ${guildId} `
                            + `(session_id tidak tersedia) — voice tidak akan tersambung`
                        );
                        buffers.delete(guildId);
                    }
                }, 8000);
            }
        }
        origServer(payload);
    };

    const origState = client.voice.onVoiceStateUpdate.bind(client.voice);
    client.voice.onVoiceStateUpdate = (payload) => {
        const guildId = payload.guild_id || payload.channel_id;
        // Only our own voice state carries the session_id we need.
        if (guildId && methodsByGuild.has(guildId) && payload.user_id === client.user?.id) {
            const buf = bufferFor(guildId);
            buf.state = payload;
            deliver(guildId);
        }
        origState(payload);
    };

    const bridge = {
        /**
         * v14-style adapter creator for @discordjs/voice.
         *
         * `sendPayload` carries the gateway voice packets (op 4 = join /
         * leave voice state) over the MAIN gateway shard — exactly what the
         * stock discord.js adapter does.
         */
        adapterCreator(guildId) {
            return (methods) => {
                methodsByGuild.set(guildId, methods);
                const shard = client.guilds.cache.get(guildId)?.shard;
                return {
                    sendPayload: (data) => {
                        const s = client.guilds.cache.get(guildId)?.shard;
                        if (!s || s.status !== SHARD_READY) return false;
                        s.send(data);
                        return true;
                    },
                    destroy: () => {
                        methodsByGuild.delete(guildId);
                        buffers.delete(guildId);
                    },
                };
            };
        },

        /** Test/diagnostic helper: is a guild's voice handshake complete? */
        hasPending(guildId) {
            const buf = buffers.get(guildId);
            return !!(buf && (buf.state || buf.server));
        },
    };

    client.__sbmVoiceBridge = bridge;
    return bridge;
}

/**
 * Convenience accessor used by the engines: returns the bridge for a client,
 * installing it on first use.
 */
function adapterCreatorFor(client, guildId) {
    const bridge = installVoiceBridge(client);
    return bridge.adapterCreator(guildId);
}

module.exports = { installVoiceBridge, adapterCreatorFor };
