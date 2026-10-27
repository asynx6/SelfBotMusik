"use strict";

const dbModule = require("./database");

function getDb(customDb) {
    return customDb || dbModule.db;
}

function createPlaylist(name, description = null, customDb = null) {
    if (!name || typeof name !== "string" || !name.trim()) {
        throw new Error("Playlist name is required");
    }
    const db = getDb(customDb);
    const now = Date.now();
    const info = db.prepare(`
        INSERT INTO playlists (name, description, created_at, updated_at)
        VALUES (?, ?, ?, ?)
    `).run(name.trim(), description ? description.trim() : null, now, now);

    return getPlaylistById(info.lastInsertRowid, customDb);
}

function getPlaylistById(id, customDb = null) {
    const db = getDb(customDb);
    const row = db.prepare("SELECT * FROM playlists WHERE id = ?").get(id);
    if (!row) return null;
    const countRow = db.prepare("SELECT COUNT(*) as count FROM playlist_tracks WHERE playlist_id = ?").get(id);
    return {
        ...row,
        track_count: countRow ? countRow.count : 0
    };
}

function listPlaylists({ limit = 50, offset = 0 } = {}, customDb = null) {
    const db = getDb(customDb);
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const safeOffset = Math.max(0, Number(offset) || 0);

    const rows = db.prepare(`
        SELECT p.*, COUNT(pt.track_id) as track_count
        FROM playlists p
        LEFT JOIN playlist_tracks pt ON p.id = pt.playlist_id
        GROUP BY p.id
        ORDER BY p.updated_at DESC
        LIMIT ? OFFSET ?
    `).all(safeLimit, safeOffset);

    const totalRow = db.prepare("SELECT COUNT(*) as total FROM playlists").get();
    return {
        playlists: rows,
        total: totalRow ? totalRow.total : 0
    };
}

function updatePlaylist(id, { name, description } = {}, customDb = null) {
    const db = getDb(customDb);
    const existing = getPlaylistById(id, customDb);
    if (!existing) throw new Error("Playlist not found");

    const newName = (typeof name === "string" && name.trim()) ? name.trim() : existing.name;
    const newDesc = description !== undefined
        ? (description ? String(description).trim() : null)
        : existing.description;
    const now = Date.now();

    db.prepare(`
        UPDATE playlists
        SET name = ?, description = ?, updated_at = ?
        WHERE id = ?
    `).run(newName, newDesc, now, id);

    return getPlaylistById(id, customDb);
}

function deletePlaylist(id, customDb = null) {
    const db = getDb(customDb);
    const info = db.prepare("DELETE FROM playlists WHERE id = ?").run(id);
    return { deleted: info.changes > 0 };
}

function addTrackToPlaylist(playlistId, trackId, customDb = null) {
    const db = getDb(customDb);
    const playlist = getPlaylistById(playlistId, customDb);
    if (!playlist) throw new Error("Playlist not found");

    const track = db.prepare("SELECT id FROM tracks WHERE id = ?").get(trackId);
    if (!track) throw new Error("Track not found");

    // Check if already in playlist (primary key constraint)
    const existing = db.prepare(
        "SELECT 1 FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?"
    ).get(playlistId, trackId);
    if (existing) {
        return { added: false, duplicate: true };
    }

    // Next position = MAX(position) + 1
    const posRow = db.prepare(
        "SELECT MAX(position) as max_pos FROM playlist_tracks WHERE playlist_id = ?"
    ).get(playlistId);
    const nextPos = (posRow && posRow.max_pos !== null) ? posRow.max_pos + 1 : 0;

    const now = Date.now();
    db.prepare(`
        INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
        VALUES (?, ?, ?, ?)
    `).run(playlistId, trackId, nextPos, now);

    db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(now, playlistId);

    return { added: true, position: nextPos };
}

function removeTrackFromPlaylist(playlistId, trackId, customDb = null) {
    const db = getDb(customDb);
    const info = db.prepare(
        "DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?"
    ).run(playlistId, trackId);

    if (info.changes > 0) {
        db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(Date.now(), playlistId);
    }
    return { removed: info.changes > 0 };
}

function getPlaylistTracks(playlistId, customDb = null) {
    const db = getDb(customDb);
    const playlist = getPlaylistById(playlistId, customDb);
    if (!playlist) throw new Error("Playlist not found");

    const rows = db.prepare(`
        SELECT t.*, pt.position, pt.added_at
        FROM playlist_tracks pt
        JOIN tracks t ON pt.track_id = t.id
        WHERE pt.playlist_id = ?
        ORDER BY pt.position ASC
    `).all(playlistId);

    return {
        playlist,
        tracks: rows
    };
}

function reorderPlaylistTracks(playlistId, trackIdsOrder, customDb = null) {
    if (!Array.isArray(trackIdsOrder)) {
        throw new Error("trackIdsOrder must be an array of track IDs");
    }
    const db = getDb(customDb);
    const playlist = getPlaylistById(playlistId, customDb);
    if (!playlist) throw new Error("Playlist not found");

    const update = db.prepare(
        "UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_id = ?"
    );

    const runTransaction = db.transaction((ids) => {
        for (let i = 0; i < ids.length; i++) {
            update.run(i, playlistId, ids[i]);
        }
        db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(Date.now(), playlistId);
    });

    runTransaction(trackIdsOrder);
    return getPlaylistTracks(playlistId, customDb);
}

module.exports = {
    createPlaylist,
    getPlaylistById,
    listPlaylists,
    updatePlaylist,
    deletePlaylist,
    addTrackToPlaylist,
    removeTrackFromPlaylist,
    getPlaylistTracks,
    reorderPlaylistTracks,
};
