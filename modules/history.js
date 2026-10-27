"use strict";

const dbModule = require("./database");

function getDb(customDb) {
    return customDb || dbModule.db;
}

function recordHistory(trackId, msPlayed = 0, customDb = null) {
    const db = getDb(customDb);
    const id = Number(trackId);
    if (!Number.isInteger(id)) return null;

    const info = db.prepare(`
        INSERT INTO history (track_id, played_at, ms_played)
        VALUES (?, ?, ?)
    `).run(id, Date.now(), Number(msPlayed) || 0);

    return { id: info.lastInsertRowid, track_id: id };
}

function listHistory({ limit = 50, offset = 0 } = {}, customDb = null) {
    const db = getDb(customDb);
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const safeOffset = Math.max(0, Number(offset) || 0);

    const rows = db.prepare(`
        SELECT h.id as history_id, h.played_at, h.ms_played, t.*
        FROM history h
        JOIN tracks t ON h.track_id = t.id
        ORDER BY h.id DESC
        LIMIT ? OFFSET ?
    `).all(safeLimit, safeOffset);

    const totalRow = db.prepare("SELECT COUNT(*) as total FROM history").get();
    return {
        history: rows,
        total: totalRow ? totalRow.total : 0
    };
}

module.exports = {
    recordHistory,
    listHistory,
};
