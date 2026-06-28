"use strict";

const db = require("./database");

// Runtime config keys persisted in the `settings` table.
const LAVALINK_KEYS = ["lavalink_host", "lavalink_port", "lavalink_password", "lavalink_secure"];
const TARGET_KEYS = ["guild_id", "channel_id"];

function loadRuntime() {
    const all = db.getAllSettings();
    return {
        lavaHost: all.lavalink_host || "",
        lavaPort: Number(all.lavalink_port || 2333),
        lavaPass: all.lavalink_password || "",
        lavaSecure: String(all.lavalink_secure || "false") === "true",
        guildId: all.guild_id || "",
        channelId: all.channel_id || "",
    };
}

// Save a partial Runtime patch to the settings table.
function saveRuntime(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
        if (v === undefined || v === null || v === "") continue;
        const key = runtimeToSettingKey(k);
        if (key) db.setSetting(key, v);
    }
}

function runtimeToSettingKey(runtimeKey) {
    const map = {
        lavaHost: "lavalink_host",
        lavaPort: "lavalink_port",
        lavaPass: "lavalink_password",
        lavaSecure: "lavalink_secure",
        guildId: "guild_id",
        channelId: "channel_id",
    };
    return map[runtimeKey] || null;
}

function publicConfig(rt) {
    return {
        guildId: rt.guildId,
        channelId: rt.channelId,
        lavaHost: rt.lavaHost,
        lavaPort: rt.lavaPort,
        lavaPass: maskConfigString(rt.lavaPass || "", 0),
        lavaSecure: rt.lavaSecure,
    };
}

function maskConfigString(s, keep = 0) {
    if (!s) return "";
    if (s.length <= keep) return "***";
    return "•".repeat(Math.max(3, s.length - keep));
}

module.exports = {
    loadRuntime,
    saveRuntime,
    publicConfig,
    maskConfigString,
};
