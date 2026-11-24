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
    // Debounce the offline transition: the public node drops sockets every few
    // minutes and Poru reconnects in ~1s. Flipping `connected:false` on the
    // first close made the dashboard light strobe. Only report offline if the
    // node is still down after the grace period.
    let downTimer = null;
    const OFFLINE_GRACE_MS = 5000;

    poru.on("nodeConnect", (node) => {
        console.log(`🛰️  Node [${node.name}] connected`);
        if (downTimer) { clearTimeout(downTimer); downTimer = null; }
        try { patch({ connected: true, lastError: null }); } catch (e) {
            console.error("nodeConnect patch:", e.message);
        }
    });

    poru.on("nodeDisconnect", (node, reason) => {
        let code = reason;
        if (reason && typeof reason === "object") code = reason.reason || reason.code;
        console.warn(`⚠️  Node [${node.name}] disconnected: ${code}`);
        if (process.env.SBM_TRACE_WS) {
            console.warn("   stack: " + (new Error().stack || "").split("\n").slice(1, 8).join("\n   "));
        }
        if (code === 4000) {
            console.error("❌ Lavalink rate-limit (4000). Pause and retry later.");
            try { patch({ connected: false }); } catch {}
            try { poru.removeNode(node.name); } catch {}
            return;
        }
        if (downTimer) clearTimeout(downTimer);
        downTimer = setTimeout(() => {
            downTimer = null;
            const n = poru.nodes?.get(node.name);
            if (n && n.isConnected) return; // already recovered — stay quiet
            try { patch({ connected: false }); } catch {}
        }, OFFLINE_GRACE_MS);
    });

    poru.on("nodeError", (node, err) => {
        const msg = err?.message || String(err || "");
        console.error(`❌ Node [${node.name}] error: ${msg.slice(0, 240)}`);
        // ponytail: a transient nodeError does NOT mean Lavalink is down.
        // Previously this flipped `connected:false` even while the node's WS
        // stayed alive, so the dashboard's "Lavalink ready" light flickered on
        // and off. The single source of truth is the node's own connection
        // flag; `nodeDisconnect` handles the real down transition. Keep the
        // message for diagnostics only, never as a readiness signal.
        try { patch({ lastError: msg.slice(0, 240) }); } catch {}
    });
}

module.exports = { createPoru, wirePoruEvents };
