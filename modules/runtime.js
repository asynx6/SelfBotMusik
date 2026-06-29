"use strict";

const cfg = require("./config");
const stateMod = require("./state");

// Mutable, in-memory. Persisted to SQLite via cfg.saveRuntime().
const Runtime = cfg.loadRuntime();

function snapshot() {
    return { ...Runtime };
}

async function applyRuntimeConfig(patch, ctx) {
    // ctx exposes (all required by runtime.js):
    //   - ensurePoru(), markPoruDirty(), removePoruNode()
    //   - leaveVC(force), joinVC(guildId, channelId), getPlayer()
    //   - stopAll() — clear queue + stop player, used before node cycles
    //   - State, patch()
    const allowed = ["guildId", "channelId", "lavaHost", "lavaPort", "lavaPass", "lavaSecure"];
    const chk = async () => {
        const p = ctx.getPlayer?.();
        if (p && typeof ctx.stopAll === "function") { try { await ctx.stopAll(false); } catch {} }
    };
    const changed = {};
    let touched = false;
    for (const k of allowed) {
        if (k in (patch || {})) {
            const v = patch[k];
            if (v === null || v === undefined || v === "") continue;
            if (Runtime[k] === v) continue;
            changed[k] = { from: Runtime[k], to: v };
            Runtime[k] = v;
            touched = true;
        }
    }
    if (!touched) return { changed: false };

    cfg.saveRuntime({
        lavaHost: Runtime.lavaHost,
        lavaPort: Runtime.lavaPort,
        lavaPass: Runtime.lavaPass,
        lavaSecure: Runtime.lavaSecure,
        guildId: Runtime.guildId,
        channelId: Runtime.channelId,
    });

    try {
        const channelOrGuildChanged = !!changed.guildId || !!changed.channelId;
        const lavaChanged = !!changed.lavaHost || !!changed.lavaPort
            || !!changed.lavaPass || (changed.lavaSecure != null);

        // If Lavalink host/pass cleared → tear everything down.
        if (!Runtime.lavaHost || !Runtime.lavaPass) {
            await chk();
            try { await ctx.removePoruNode(); } catch {}
            try { await ctx.leaveVC(true); } catch {}
            stateMod.patch({ voiceConnected: false, lastError: null });
            ctx.markPoruDirty();
            return { changed: true, cleared: true };
        }

        if (channelOrGuildChanged && !lavaChanged) {
            try { await ctx.leaveVC(false); } catch {}
            try {
                await ctx.ensurePoru();
                await ctx.joinVC(Runtime.guildId, Runtime.channelId);
            } catch (e) {
                console.error("❌ joinVC failed:", e.message);
                stateMod.patch({ lastError: e.message });
            }
            return { changed: true };
        }

        // Lavalink config changed: cycle the node.
        ctx.markPoruDirty();
        const p = ctx.getPlayer?.();
        if (p) { await chk(); }
        try {
            await ctx.ensurePoru();
        } catch (e) {
            stateMod.patch({ lastError: e.message });
        }
        // Wait up to 10s for a fresh node to appear.
        const t0 = Date.now();
        while (!stateMod.State.connected && Date.now() - t0 < 10000) {
            await new Promise((r) => setTimeout(r, 200));
        }
        if (stateMod.State.connected && Runtime.channelId && Runtime.guildId) {
            try { await ctx.joinVC(Runtime.guildId, Runtime.channelId); }
            catch (e) { console.error("❌ rejoinVC:", e.message); }
        }
        return { changed: true };
    } catch (e) {
        console.error("applyRuntimeConfig failed:", e.message);
        stateMod.patch({ lastError: e.message });
        return { changed: true, error: e.message };
    }
}

module.exports = { Runtime, applyRuntimeConfig, snapshot };
