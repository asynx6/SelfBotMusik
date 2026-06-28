"use strict";

const { Poru } = require("poru");

// Builds a single shared Poru instance. We start with empty nodes so
// the process boots cleanly even when Lavalink settings are blank.
// ensurePoru() must be called before any node-bound operation.
function createPoru(discordClient) {
    return new Poru(discordClient, [], {
        library: "discord.js",
        defaultPlatform: "ytsearch",
        reconnectTries: 3,
        reconnectTimeout: 5000,
    });
}

// Wire connection-state listeners onto the poru instance; updates State.
function wirePoruEvents(poru, stateMod) {
    poru.on("nodeConnect", (node) => {
        console.log(`🛰️  Node [${node.name}] connected`);
        stateMod.patch({ connected: true, lastError: null });
    });

    poru.on("nodeDisconnect", (node, reason) => {
        let code = reason;
        if (reason && typeof reason === "object") code = reason.code;
        console.warn(`⚠️  Node [${node.name}] disconnected: ${code}`);
        if (reason && typeof reason === "object") {
            console.warn(`   reason: ${JSON.stringify(reason).slice(0, 200)}`);
        }
        stateMod.patch({ connected: false });
        if (code === 4000) {
            console.error("❌ Lavalink rate-limit (4000). Pause and retry later.");
            try { poru.removeNode(node.name); } catch {}
        }
    });

    poru.on("nodeError", (node, err) => {
        console.error(`❌ Node [${node.name}] error:`, err?.message || err);
        stateMod.patch({ lastError: String(err?.message || err) });
    });
}

module.exports = { createPoru, wirePoruEvents };
