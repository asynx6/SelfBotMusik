"use strict";

/**
 * Voice bridge tests.
 *
 * @discordjs/voice v0.18 only starts its networking from addServerPacket();
 * addStatePacket() stores the packet but never retries. So when Discord
 * delivers VOICE_SERVER_UPDATE before VOICE_STATE_UPDATE, the connection hangs
 * in "signalling" forever: no UDP socket, no audio, and no error anywhere —
 * the bot is visible in the channel while ffmpeg decodes into the void.
 *
 * modules/voice-bridge.js re-orders the packets so this can never happen.
 */

const test = require("node:test");
const assert = require("node:assert");
const { Client } = require("discord.js-selfbot-v13");
const { joinVoiceChannel, VoiceConnectionStatus } = require("@discordjs/voice");
const { installVoiceBridge } = require("../modules/voice-bridge");

const GUILD = "111111111111111111";
const CHANNEL = "222222222222222222";
const USER = "333333333333333333";

const SERVER_PACKET = {
    guild_id: GUILD,
    channel_id: CHANNEL,
    token: "tok",
    endpoint: "127.0.0.1",
};

const STATE_PACKET = {
    guild_id: GUILD,
    channel_id: CHANNEL,
    session_id: "sess",
    user_id: USER,
    self_mute: false,
    self_deaf: true,
};

function makeClient() {
    const client = new Client({ checkUpdate: false });
    client.user = { id: USER };
    client.guilds.cache.set(GUILD, {
        id: GUILD,
        client,
        shard: { status: 0, send: () => true },
    });
    installVoiceBridge(client);
    return client;
}

/**
 * Drive a connection with the given packet order and report whether the
 * networking layer actually started.
 */
function connectWithOrder(order) {
    const client = makeClient();
    const conn = joinVoiceChannel({
        guildId: GUILD,
        channelId: CHANNEL,
        adapterCreator: client.__sbmVoiceBridge.adapterCreator(GUILD),
        selfDeaf: true,
        selfMute: false,
    });
    // The fake endpoint refuses the connection; swallow the resulting error so
    // it does not crash the test process.
    conn.on("stateChange", () => {});
    conn.on("error", () => {});

    for (const kind of order) {
        if (kind === "server") client.voice.onVoiceServer({ ...SERVER_PACKET });
        else client.voice.onVoiceStateUpdate({ ...STATE_PACKET });
    }

    const status = conn.state.status;
    try { conn.destroy(); } catch {}
    return { status, started: status === VoiceConnectionStatus.Connecting || status === VoiceConnectionStatus.Ready };
}

test("voice bridge: state-then-server order starts the networking layer", () => {
    const { started, status } = connectWithOrder(["state", "server"]);
    assert.ok(started, `connection should start, but status was ${status}`);
});

test("voice bridge: server-then-state order also starts the networking layer", () => {
    // This is the order that used to hang forever in "signalling".
    const { started, status } = connectWithOrder(["server", "state"]);
    assert.ok(started, `connection should start, but status was ${status}`);
});

test("voice bridge: a voice state update for another user is ignored", () => {
    const client = makeClient();
    const conn = joinVoiceChannel({
        guildId: GUILD,
        channelId: CHANNEL,
        adapterCreator: client.__sbmVoiceBridge.adapterCreator(GUILD),
        selfDeaf: true,
        selfMute: false,
    });
    conn.on("stateChange", () => {});
    conn.on("error", () => {});

    // Somebody else joins the channel — their session_id is useless to us.
    client.voice.onVoiceStateUpdate({ ...STATE_PACKET, user_id: "999999999999999999" });
    client.voice.onVoiceServer({ ...SERVER_PACKET });

    assert.equal(
        conn.state.status,
        VoiceConnectionStatus.Signalling,
        "must not start networking on another member's voice state"
    );
    try { conn.destroy(); } catch {}
});

test("voice bridge: installVoiceBridge is idempotent", () => {
    const client = makeClient();
    const first = client.__sbmVoiceBridge;
    const second = installVoiceBridge(client);
    assert.equal(first, second, "the bridge must not be installed twice");
});
