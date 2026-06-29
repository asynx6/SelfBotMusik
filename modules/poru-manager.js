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
// Accept a patch function directly (safer than wrapping the object).
function wirePoruEvents(poru, patch) {
    if (typeof patch !== "function") return;
    poru.on("nodeConnect", (node) => {
        console.log(`🛰️  Node [${node.name}] connected`);
        try { patch({ connected: true, lastError: null }); } catch (e) {
            console.error("nodeConnect patch:", e.message);
        }
    });

    poru.on("nodeDisconnect", (node, reason) => {
        let code = reason;
        if (reason && typeof reason === "object") code = reason.code;
        console.warn(`⚠️  Node [${node.name}] disconnected: ${code}`);
        if (reason && typeof reason === "object") {
            console.warn(`   reason: ${JSON.stringify(reason).slice(0, 200)}`);
        }
        try { patch({ connected: false }); } catch {}
        if (code === 4000) {
            console.error("❌ Lavalink rate-limit (4000). Pause and retry later.");
            try { poru.removeNode(node.name); } catch {}
        }
    });

    poru.on("nodeError", (node, err) => {
        const msg = err?.message || String(err || "");
        console.error(`❌ Node [${node.name}] error: ${msg.slice(0, 240)}`);
        try { patch({ lastError: msg.slice(0, 240) }); } catch {}
    });
}

module.exports = { createPoru, wirePoruEvents };
