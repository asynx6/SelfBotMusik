"use strict";

const dbModule = require("./database");

function getDb(customDb) {
    return customDb || dbModule.db;
}

function toggleLike(trackId, customDb = null) {
    const db = getDb(customDb);
    const id = Number(trackId);
    if (!Number.isInteger(id)) throw new Error("Invalid track ID");

    const track = db.prepare("SELECT id FROM tracks WHERE id = ?").get(id);
    if (!track) throw new Error("Track not found");

    const existing = db.prepare("SELECT 1 FROM likes WHERE track_id = ?").get(id);
    if (existing) {
        db.prepare("DELETE FROM likes WHERE track_id = ?").run(id);
        return { liked: false, track_id: id };
    } else {
        db.prepare("INSERT INTO likes (track_id, liked_at) VALUES (?, ?)").run(id, Date.now());
        return { liked: true, track_id: id };
    }
}

function isLiked(trackId, customDb = null) {
    const db = getDb(customDb);
    const id = Number(trackId);
    if (!Number.isInteger(id)) return false;
    const row = db.prepare("SELECT 1 FROM likes WHERE track_id = ?").get(id);
    return !!row;
}

function listLikes({ limit = 50, offset = 0 } = {}, customDb = null) {
    const db = getDb(customDb);
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const safeOffset = Math.max(0, Number(offset) || 0);

    const rows = db.prepare(`
        SELECT t.*, l.liked_at
        FROM likes l
        JOIN tracks t ON l.track_id = t.id
        ORDER BY l.liked_at DESC
        LIMIT ? OFFSET ?
    `).all(safeLimit, safeOffset);

    const totalRow = db.prepare("SELECT COUNT(*) as total FROM likes").get();
    return {
        tracks: rows,
        total: totalRow ? totalRow.total : 0
    };
}

module.exports = {
    toggleLike,
    isLiked,
    listLikes,
};
