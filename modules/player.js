"use strict";

const stateMod = require("./state");

// Loop constants
const LOOP_LABELS = ["OFF", "TRACK", "QUEUE"];
const LOOP_PORTU = ["NONE", "TRACK", "QUEUE"];

function getLoop() { return stateMod.State.loop || 0; }

async function cycleLoop(poru, Runtime) {
    const next = (getLoop() + 1) % 3;
    stateMod.patch({ loop: next });
    const p = getPlayer(poru, Runtime);
    if (p) {
        try { p.setLoop(LOOP_PORTU[next]); } catch {}
    }
    return { mode: next, label: LOOP_LABELS[next] };
}

async function setLoop(poru, Runtime, mode) {
    const idx = Number(mode);
    if (!Number.isInteger(idx) || idx < 0 || idx > 2) {
        throw new Error("Invalid loop mode (0..2)");
    }
    stateMod.patch({ loop: idx });
    const p = getPlayer(poru, Runtime);
    if (p) {
        try { p.setLoop(LOOP_PORTU[idx]); } catch {}
    }
    return { mode: idx, label: LOOP_LABELS[idx] };
}

// --- Search ---
async function searchTracks(poru, query, requester) {
    const node = [...poru.nodes.values()].find((n) => n.isConnected);
    if (!node) throw new Error("Lavalink node is not connected");

    let q = String(query || "").trim();
    if (/^https?:\/\//i.test(q)) {
        // pass URL as-is
    } else {
        q = q.replace(/^(ytsearch|ytmsearch|spsearch|dzsearch|amsearch|scsearch):/i, "");
        if (!q) throw new Error("Empty query");
    }
    const res = await poru.resolve({ query: q, source: "ytsearch", requester });
    if (!res) throw new Error("Lavalink did not respond");
    if (res.loadType === "empty" || res.loadType === "error") {
        throw new Error("No results");
    }
    if (res.loadType === "track") return [res.tracks[0]];
    if (res.loadType === "search") return [res.tracks[0]];
    if (res.loadType === "playlist") return [res.tracks[0]];
    return [];
}

// --- queue-append vs start-fresh logic ---
async function enqueue(poru, query, requester, ensurePoru, joinVC, Runtime) {
    await ensurePoru();
    const tracks = await searchTracks(poru, query, requester);
    if (!tracks.length) throw new Error("No results from Lavalink");

    const t = tracks[0];
    if (t && typeof t === "object" && "info" in t) t.requester = requester;
    const info = t.info || {};

    if (!Runtime.guildId || !Runtime.channelId) {
        throw new Error("Set Guild ID & Voice Channel first (Settings → Connect)");
    }
    const player = poru.players.get(Runtime.guildId);
    if (!player) {
        await joinVC(Runtime.guildId, Runtime.channelId);
    }
    const p2 = poru.players.get(Runtime.guildId);
    if (!p2) throw new Error("Failed to create player");

    const hadAnythingPlaying = !!(p2.currentTrack || (p2.queue && p2.queue.length > 0));
    if (!hadAnythingPlaying) {
        p2.queue.add(t);
        try { await p2.play(); } catch (e) { console.error("enqueue play() failed:", e.message); }
    } else {
        p2.queue.add(t);
    }

    return {
        title: info.title || "Unknown",
        author: info.author || "Unknown",
        duration: info.length || 0,
        uri: info.uri || "",
        thumbnail: info.artworkUrl || (info.identifier ? `https://i.ytimg.com/vi/${info.identifier}/hqdefault.jpg` : ""),
        encoded: t.track || "",
        requester,
        queued: hadAnythingPlaying,
        queuePosition: hadAnythingPlaying ? (p2.queue.length - 1) : 0,
        playing: !hadAnythingPlaying,
    };
}

async function skipTrack(poru, Runtime) {
    const p = poru.players.get(Runtime.guildId);
    if (!p) throw new Error("No active player");
    if (!p.currentTrack) throw new Error("Nothing is playing");
    const hadMore = (p.queue?.length || 0) > 0;
    await p.skip();
    // If queue is empty after skip, the player would loop on nothing. Force-stop
    // so position + state clear out cleanly.
    if (!hadMore) {
        try { await p.stop(); } catch {}
        stateMod.patch({ playing: null, paused: false, position: 0 });
        return { ok: true, remaining: 0, ended: true };
    }
    return { ok: true, remaining: p.queue?.length || 0, ended: false };
}

async function stopAll(poru, Runtime) {
    try {
        const p = poru.players.get(Runtime.guildId);
        if (p) {
            try { p.queue.length = 0; } catch {}
            try { await p.stop(); } catch {}
        }
    } catch { /* ignore */ }
    stateMod.patch({ playing: null, queue: [], paused: false, position: 0 });
}

async function togglePause(poru, Runtime) {
    const p = poru.players.get(Runtime.guildId);
    if (!p) throw new Error("No player");
    if (!p.currentTrack) throw new Error("Nothing is playing");
    if (p.isPlaying) await p.pause(true);
    else if (p.isPaused) await p.pause(false);
    return { paused: !!p.isPaused };
}

async function setVolume(poru, Runtime, v) {
    stateMod.patch({ volume: Math.max(0, Math.min(200, Number(v) || 0)) });
    const p = poru.players.get(Runtime.guildId);
    if (p) { try { await p.setVolume(stateMod.State.volume); } catch {} }
    return { volume: stateMod.State.volume };
}

async function removeAt(poru, Runtime, idx) {
    const p = poru.players.get(Runtime.guildId);
    if (!p) return { removed: 0 };
    if (idx === 0) throw new Error("Cannot remove the currently playing track — Use Stop");
    const realIdx = idx - 1;
    const upcoming = Array.isArray(p.queue) ? p.queue : [];
    if (realIdx < 0 || realIdx >= upcoming.length) throw new Error("Index out of range");
    upcoming.splice(realIdx, 1);
    return { removed: 1, remaining: upcoming.length };
}

async function clearQueue(poru, Runtime) {
    const p = poru.players.get(Runtime.guildId);
    if (!p) return { cleared: 0, kept: 1 };
    const upcoming = Array.isArray(p.queue) ? p.queue : [];
    const removed = upcoming.length;
    try { upcoming.length = 0; } catch {}
    return { cleared: removed, kept: p.currentTrack ? 1 : 0 };
}

// Returns the playback snapshot to send clients.
function getSnapshot(poru, Runtime) {
    const p = poru.players.get(Runtime.guildId);
    if (!p) return { playing: null, queue: [] };
    const queueSnap = [];
    if (p.currentTrack) {
        const cur = p.currentTrack;
        queueSnap.push(serializeTrack(cur, Runtime, true));
    }
    if (Array.isArray(p.queue)) {
        for (const t of p.queue) {
            queueSnap.push(serializeTrack(t, Runtime, false));
        }
    }
    return { playing: queueSnap[0] || null, queue: queueSnap };
}

function serializeTrack(track, Runtime, isCurrent) {
    const info = track?.info || {};
    return {
        title: info.title || "Unknown",
        author: info.author || "Unknown",
        duration: info.length || 0,
        uri: info.uri || "",
        thumbnail: info.artworkUrl || (info.identifier ? `https://i.ytimg.com/vi/${info.identifier}/hqdefault.jpg` : ""),
        encoded: track?.track || "",
        requester: track?.requester?.tag || track?.requester || "—",
        isCurrent,
    };
}

function getPlayer(poru, Runtime) {
    return poru.players.get(Runtime.guildId) || null;
}

module.exports = {
    LOOP_LABELS,
    cycleLoop,
    setLoop,
    enqueue,
    searchTracks,
    skipTrack,
    stopAll,
    togglePause,
    setVolume,
    removeAt,
    clearQueue,
    getSnapshot,
    getPlayer,
};
