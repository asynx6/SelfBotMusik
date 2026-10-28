"use strict";

const dbModule = require("./database");
const library = require("./library");
const downloads = require("./downloads");
const history = require("./history");
const likes = require("./likes");

function getDb(customDb) {
    return customDb || dbModule.db;
}

// Score weights
const WEIGHTS = {
    LIBRARY_BASE: 10,        // Track exists in library
    LOCAL_BONUS: 25,         // Track is downloaded locally
    LIKED_BONUS: 30,         // Track is liked
    RECENT_PLAY_BONUS: 20,   // Played recently (within 7 days)
    FREQUENT_PLAY_BONUS: 15, // High play count
    SAME_ARTIST_BONUS: 15,   // Matches current artist
    SAME_ALBUM_BONUS: 10,    // Matches current album
    LASTFM_BONUS: 20,        // Found in Last.fm similar artists
    YOUTUBE_BONUS: 5,        // Found in YouTube search
};

function getTrackScore(track, context = {}) {
    let score = WEIGHTS.LIBRARY_BASE;

    // Local file bonus
    if (track.file_path) score += WEIGHTS.LOCAL_BONUS;

    // Like bonus
    if (track.liked || track.isLiked || track.is_liked) score += WEIGHTS.LIKED_BONUS;

    // Recent play bonus (played within 7 days)
    if (track.last_played_at) {
        const daysSince = (Date.now() - track.last_played_at) / (1000 * 60 * 60 * 24);
        if (daysSince <= 7) score += WEIGHTS.RECENT_PLAY_BONUS;
    }

    // Frequent play bonus
    if (track.play_count >= 5) score += WEIGHTS.FREQUENT_PLAY_BONUS;
    else if (track.play_count >= 2) score += WEIGHTS.FREQUENT_PLAY_BONUS * 0.5;

    // Context matching (current track context)
    if (context.currentTrack) {
        if (track.artist && track.artist === context.currentTrack.artist) {
            score += WEIGHTS.SAME_ARTIST_BONUS;
        }
        if (track.album && track.album === context.currentTrack.album) {
            score += WEIGHTS.SAME_ALBUM_BONUS;
        }
    }

    return score;
}

async function getLibraryCandidates(limit = 50, customDb = null) {
    const db = getDb(customDb);
    const rows = db.prepare(`
        SELECT t.*,
            CASE WHEN l.track_id IS NOT NULL THEN 1 ELSE 0 END as is_liked
        FROM tracks t
        LEFT JOIN likes l ON t.id = l.track_id
        ORDER BY t.last_played_at DESC, t.play_count DESC
        LIMIT ?
    `).all(limit);

    return rows;
}

async function getSimilarFromLastFm(artist, limit = 10) {
    // Placeholder for Last.fm API integration
    // Would call Last.fm API: artist.getSimilar
    // For now return empty array
    return [];
}

async function searchYouTube(query, limit = 10) {
    // Placeholder for YouTube search via Lavalink
    // Would call playerMod.searchTracks with ytsearch
    return [];
}

async function getRecommendations(currentTrack, options = {}) {
    const {
        limit = 10,
        includeLocal = true,
        includeExternal = false,
        customDb = null
    } = options;

    const candidates = [];

    // 1. Get library tracks as base candidates
    const libraryTracks = await getLibraryCandidates(100);
    for (const track of libraryTracks) {
        // Skip the currently playing track
        if (currentTrack && track.id === currentTrack.id) continue;

        const score = getTrackScore(track, { currentTrack });
        candidates.push({
            track,
            score,
            source: "library",
        });
    }

    // 2. Add external candidates if enabled
    if (includeExternal && currentTrack?.artist) {
        // Last.fm similar artists (placeholder)
        // const lastFmTracks = await getSimilarFromLastFm(currentTrack.artist, 10);
        // for (const track of lastFmTracks) {
        //     candidates.push({ track, score: WEIGHTS.LASTFM_BONUS, source: "lastfm" });
        // }

        // YouTube search (placeholder)
        // const ytTracks = await searchYouTube(currentTrack.title, 10);
        // for (const track of ytTracks) {
        //     candidates.push({ track, score: WEIGHTS.YOUTUBE_BONUS, source: "youtube" });
        // }
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    // Deduplicate by track ID
    const seen = new Set();
    const unique = [];
    for (const c of candidates) {
        if (!seen.has(c.track.id)) {
            seen.add(c.track.id);
            unique.push(c);
            if (unique.length >= limit) break;
        }
    }

    return unique.map((c) => ({
        ...c.track,
        recommendationScore: c.score,
        recommendationSource: c.source,
    }));
}

async function getAutoplayRecommendations(currentTrack, options = {}) {
    const {
        count = 1,
        includeLocal = true,
        customDb = null
    } = options;

    const recommendations = await getRecommendations(currentTrack, {
        limit: count * 3, // Get more to have pool to pick from
        includeLocal: true,
        customDb,
    });

    // Filter local vs external based on option
    let pool = includeLocal ? recommendations : recommendations.filter(r => !r.file_path);

    if (!pool.length) return [];

    // Shuffle top candidates and pick
    const topPool = pool.slice(0, Math.min(10, pool.length));
    const shuffled = topPool.sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
}

// Called when a track ends to queue next recommendation
async function onTrackEnd(currentTrack, controller, options = {}) {
    if (!currentTrack) return null;

    const recommendations = await getAutoplayRecommendations(currentTrack, {
        count: 1,
        includeLocal: true,
    });

    if (recommendations.length === 0) return null;

    const nextTrack = recommendations[0];
    await controller.playNext([nextTrack], "Autoplay");

    return nextTrack;
}

module.exports = {
    getRecommendations,
    getAutoplayRecommendations,
    onTrackEnd,
    getTrackScore,
    WEIGHTS,
};