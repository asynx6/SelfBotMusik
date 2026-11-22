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

/**
 * Wrap `poru.resolve` so a broken upstream node cannot poison the caller.
 *
 * Public/free Lavalink nodes sit behind reverse proxies that answer with an
 * HTML error page (502/500) instead of JSON. Poru feeds that string straight
 * into its Response class, producing the useless error
 * "Cannot create property 'loadType' on string '<html>…'".
 * Translate it into something a human can act on.
 */
async function safeResolve(poru, payload) {
    let res;
    try {
        res = await poru.resolve(payload);
    } catch (e) {
        const msg = String(e?.message || e);
        if (/Cannot create property 'loadType'|<html|Unexpected token|is not valid JSON/i.test(msg)) {
            throw new Error("Node Lavalink membalas halaman error (bukan JSON) — node sedang down atau dibatasi");
        }
        throw e;
    }
    // Some node versions return the raw body instead of a Response object.
    if (!res || typeof res !== "object" || typeof res.loadType !== "string") {
        throw new Error("Node Lavalink membalas data yang tidak valid — coba lagi atau ganti node");
    }
    return res;
}

// A public node can drop its WS for a second mid-request. Retry once before
// surfacing "not connected" — the node usually reconnects on its own, and a
// failed search must not look like a broken dashboard.
const RECONNECTABLE_ERROR = /not connected|disconnected|node.*lavalink|lavalink.*node|websocket/i;
async function retryOnceOnNodeDrop(fn) {
    try {
        return await fn();
    } catch (e) {
        if (!RECONNECTABLE_ERROR.test(String(e?.message || e))) throw e;
        await new Promise((r) => setTimeout(r, 350));
        return fn();
    }
}

async function _searchTracks(poru, query, requester, opts = {}) {
    const node = [...poru.nodes.values()].find((n) => n.isConnected);
    if (!node) throw new Error("Lavalink node is not connected");

    let q = String(query || "").trim();
    if (/^https?:\/\//i.test(q)) {
        // pass URL as-is (YouTube, Spotify, SoundCloud links resolved by Lavalink plugins)
    } else {
        q = q.replace(/^(ytsearch|ytmsearch|spsearch|dzsearch|amsearch|scsearch):/i, "");
        if (!q) throw new Error("Empty query");
    }
    const res = await safeResolve(poru, { query: q, source: "ytsearch", requester });
    if (!res) throw new Error("Lavalink did not respond");
    if (res.loadType === "empty" || res.loadType === "error") {
        throw new Error("No results");
    }
    if (res.loadType === "track") return [res.tracks[0]];
    // A text query resolves to N candidates. Chat requests and `enqueue` only
    // want the best match (queueing ten near-duplicates of "Silence" is wrong),
    // so the full list is opt-in for the dashboard's search page.
    if (res.loadType === "search") return opts.all ? res.tracks : [res.tracks[0]];
    if (res.loadType === "playlist") return res.tracks;
    return [];
}

// --- Search with auto-source fallback (chat requests) ---
// Tries, in order: the query as-is (URLs pass through), then explicit
// search prefixes for sources the default search may miss. Returns ALL
// resolved tracks — playlists return their full track list.
async function _searchTracksAuto(poru, query, requester, extraSources = []) {
    const attempts = [];
    if (/^https?:\/\//i.test(query)) {
        attempts.push({ q: query, source: undefined });
    } else {
        const bare = String(query).replace(/^(ytsearch|ytmsearch|spsearch|dzsearch|amsearch|scsearch):/i, "").trim();
        attempts.push({ q: bare, source: "ytsearch" });
        for (const src of extraSources) {
            attempts.push({ q: bare, source: src });
        }
    }

    let lastError = null;
    for (const attempt of attempts) {
        const node = [...poru.nodes.values()].find((n) => n.isConnected);
        if (!node) throw new Error("Lavalink node is not connected");
        try {
            const res = await safeResolve(poru, {
                query: attempt.q,
                ...(attempt.source ? { source: attempt.source } : {}),
                requester,
            });
            if (!res || res.loadType === "empty" || res.loadType === "error") {
                lastError = new Error("No results");
                continue;
            }
            if (res.loadType === "track") return { tracks: [res.tracks[0]], playlistName: null };
            if (res.loadType === "search") return { tracks: [res.tracks[0]], playlistName: null };
            if (res.loadType === "playlist") {
                return { tracks: res.tracks, playlistName: res.playlist?.name || null };
            }
        } catch (e) {
            lastError = e;
        }
    }
    throw lastError || new Error("No results");
}

async function searchTracks(poru, query, requester, opts = {}) {
    return retryOnceOnNodeDrop(() => _searchTracks(poru, query, requester, opts));
}

async function searchTracksAuto(poru, query, requester, extraSources = []) {
    return retryOnceOnNodeDrop(() => _searchTracksAuto(poru, query, requester, extraSources));
}

// --- queue-append vs start-fresh logic ---
async function enqueue(poru, query, requester, ensurePoru, joinVC, Runtime) {
    await ensurePoru();
    const tracks = await searchTracks(poru, query, requester);
    if (!tracks.length) throw new Error("No results from Lavalink");

    // Attach requester to all tracks.
    for (const tr of tracks) {
        if (tr && typeof tr === "object" && "info" in tr) tr.requester = requester;
    }
    const firstTrack = tracks[0];
    const firstInfo = firstTrack?.info || {};
    const isBatch = tracks.length > 1;

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
        // First track: start it directly. Remaining go to queue.
        p2.queue.add(firstTrack);
        try { await p2.play(); } catch (e) { console.error("enqueue play() failed:", e.message); }
        // If batch (playlist), queue the rest.
        for (let i = 1; i < tracks.length; i++) {
            p2.queue.add(tracks[i]);
        }
    } else {
        for (const tr of tracks) {
            p2.queue.add(tr);
        }
    }

    return {
        title: firstInfo.title || "Unknown",
        author: firstInfo.author || "Unknown",
        duration: firstInfo.length || 0,
        uri: firstInfo.uri || "",
        thumbnail: firstInfo.artworkUrl || (firstInfo.identifier ? `https://i.ytimg.com/vi/${firstInfo.identifier}/hqdefault.jpg` : ""),
        encoded: firstTrack?.track || "",
        requester,
        queued: hadAnythingPlaying,
        queuePosition: hadAnythingPlaying ? (p2.queue.length - tracks.length) : 0,
        playing: !hadAnythingPlaying,
        batch: isBatch ? tracks.length : undefined,
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
        stateMod.patch({ playing: null, queue: [], paused: false, position: 0 });
        return { ok: true, remaining: 0, ended: true };
    }
    // Sync state from player — the now-playing track has changed.
    const queue = [];
    if (p.currentTrack) queue.push(serializeTrack(p.currentTrack, Runtime, true));
    if (Array.isArray(p.queue)) for (const t of p.queue) queue.push(serializeTrack(t, Runtime, false));
    stateMod.patch({ playing: queue[0] || null, queue, paused: false, position: 0 });
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
    searchTracksAuto,
    skipTrack,
    stopAll,
    togglePause,
    setVolume,
    removeAt,
    clearQueue,
    getSnapshot,
    getPlayer,
};
