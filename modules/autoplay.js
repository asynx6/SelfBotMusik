"use strict";

/**
 * Autoplay with prefetch.
 *
 * Lavalink has no collaborative-filtering API, so "Spotify-like" here means:
 * seed from the track that is playing (artist / title tokens), resolve related
 * tracks through Lavalink search, score them for similarity, and blend in
 * library tracks (downloaded ones get a bonus). Candidates are prepared while
 * the current track is still playing and consumed instantly when the explicit
 * queue runs out — an explicit queue always wins over this buffer.
 */

const DEFAULT_BUFFER = 3;
const STOP_WORDS = new Set([
    "official", "video", "audio", "lyrics", "lyric", "remaster", "remastered",
    "the", "feat", "ft", "with", "hd", "hq", "mv", "cover",
]);

function normaliseKey(track) {
    if (!track) return "";
    return String(
        track.source_key || track.uri || track.encoded
        || `${track.artist || track.author || ""}|${track.title || ""}`
    ).toLowerCase().trim();
}

function tokens(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function similarity(seed, candidate) {
    const seedArtist = String(seed?.artist || seed?.author || "").toLowerCase().trim();
    const candArtist = String(candidate?.artist || candidate?.author || "").toLowerCase().trim();
    let score = 0;
    if (seedArtist && candArtist
        && (seedArtist.includes(candArtist) || candArtist.includes(seedArtist))) {
        score += 40;
    }
    const seedWords = new Set(tokens(seed?.title));
    for (const word of tokens(candidate?.title)) {
        if (seedWords.has(word)) score += 6;
    }
    if (candidate?.file_path) score += 10;
    if (candidate?.liked || candidate?.is_liked) score += 8;
    if (candidate?.play_count >= 2) score += 4;
    return score;
}

function buildQueries(seed) {
    const artist = String(seed?.artist || seed?.author || "").trim();
    const title = String(seed?.title || "").trim();
    const queries = [];
    if (artist && title) queries.push(`${artist} - ${title} similar songs`);
    if (artist) queries.push(`${artist} similar artists mix`);
    if (!queries.length && title) queries.push(`${title} similar songs`);
    return queries.slice(0, 2);
}

function createAutoplayService({
    searchOnline,             // async (query) => row-like tracks
    getLibraryCandidates,     // async (seed)  => row-like tracks
    isLavalinkReady = () => false,
    getActiveKeys = () => [], // keys already present in the explicit queue
    bufferSize = DEFAULT_BUFFER,
} = {}) {
    const buffer = [];
    const seen = new Set();
    let pending = null;
    let preparingFor = "";

    function notePlayed(track) {
        const key = normaliseKey(track);
        if (!key) return;
        seen.add(key);
        if (seen.size > 200) seen.clear(); // bound memory, accept rare repeats
    }

    function excluded(track, seed) {
        const key = normaliseKey(track);
        if (!key || seen.has(key)) return true;
        if (seed && key === normaliseKey(seed)) return true;
        if (buffer.some((c) => normaliseKey(c) === key)) return true;
        try {
            if (getActiveKeys().includes(key)) return true;
        } catch { /* best effort */ }
        return false;
    }

    async function prepare(seed) {
        if (!seed || buffer.length >= bufferSize) return null;
        if (pending) return pending;
        const seedKey = normaliseKey(seed);
        if (seedKey && seedKey === preparingFor) return null;
        preparingFor = seedKey;

        pending = (async () => {
            const pool = [];
            if (typeof getLibraryCandidates === "function") {
                try {
                    const local = await getLibraryCandidates(seed);
                    if (Array.isArray(local)) pool.push(...local);
                } catch (e) {
                    console.warn("[autoplay] kandidat library gagal:", e.message);
                }
            }
            if (typeof searchOnline === "function" && isLavalinkReady()) {
                for (const query of buildQueries(seed)) {
                    try {
                        const found = await searchOnline(query);
                        if (Array.isArray(found)) pool.push(...found);
                        if (pool.length >= bufferSize * 4) break;
                    } catch (e) {
                        console.warn(`[autoplay] pencarian gagal ("${query}"): ${e.message}`);
                    }
                }
            }
            pool.sort((a, b) => similarity(seed, b) - similarity(seed, a));
            for (const candidate of pool) {
                if (buffer.length >= bufferSize) break;
                if (excluded(candidate, seed)) continue;
                buffer.push(candidate);
            }
        })()
            .catch((e) => console.warn("[autoplay] prepare:", e.message))
            .finally(() => {
                pending = null;
                preparingFor = "";
            });
        return pending;
    }

    async function take(seed) {
        if (!buffer.length) await prepare(seed);
        // Drop anything the user queued in the meantime; explicit queue wins.
        while (buffer.length) {
            const candidate = buffer.shift();
            if (!excluded(candidate, seed)) {
                notePlayed(candidate);
                return candidate;
            }
        }
        return null;
    }

    function clear() {
        buffer.length = 0;
        seen.clear();
        preparingFor = "";
    }

    return {
        prepare,
        take,
        notePlayed,
        clear,
        get size() { return buffer.length; },
    };
}

module.exports = { createAutoplayService, similarity, buildQueries, normaliseKey };
