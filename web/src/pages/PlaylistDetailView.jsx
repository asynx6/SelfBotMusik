import React, { useState, useEffect } from "react";
import { Play, Plus, Trash2, Heart, Music2, Share2, Layers } from "lucide-react";
import { api } from "../services/api";

function formatDuration(ms) {
  if (!ms) return "0:00";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec < 10 ? "0" : ""}${sec}`;
}

export default function PlaylistDetailView({ playlistId, onNotification, onDeletePlaylist }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadPlaylist = async () => {
    try {
      const res = await api.getPlaylistTracks(playlistId);
      setData(res);
    } catch (err) {
      onNotification?.("error", err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPlaylist();
  }, [playlistId]);

  const handlePlayAll = async () => {
    if (!data?.tracks?.length) return;
    try {
      const trackIds = data.tracks.map((t) => t.id);
      await api.addToQueue(trackIds);
      onNotification?.("success", `Memutar ${trackIds.length} lagu dari ${data.playlist.name}`);
    } catch (err) {
      onNotification?.("error", err.message);
    }
  };

  const handleRemoveTrack = async (trackId) => {
    try {
      await api.removeTrackFromPlaylist(playlistId, trackId);
      onNotification?.("success", "Lagu dihapus dari playlist");
      loadPlaylist();
    } catch (err) {
      onNotification?.("error", err.message);
    }
  };

  if (!data) return <div style={{ padding: 32 }}>Memuat playlist...</div>;

  const { playlist, tracks = [] } = data;

  return (
    <div style={{ padding: "28px 32px", overflowY: "auto", flex: 1 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 24, marginBottom: 32 }}>
        <div style={{
          width: 140,
          height: 140,
          borderRadius: "var(--radius-md)",
          background: "var(--bg-tertiary)",
          border: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--accent)",
        }}>
          <Layers size={56} />
        </div>

        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", fontWeight: 700, color: "var(--fg-muted)", letterSpacing: 0.5 }}>
            Playlist
          </div>
          <h1 style={{ fontSize: 36, fontWeight: 800, margin: "4px 0" }}>{playlist.name}</h1>
          <p style={{ color: "var(--fg-secondary)", fontSize: 14, marginBottom: 12 }}>
            {playlist.description || "Tidak ada deskripsi"}
          </p>
          <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
            {tracks.length} lagu • Dibuat {new Date(playlist.created_at).toLocaleDateString()}
          </div>
        </div>
      </div>

      {/* Action Bar */}
      <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
        <button
          onClick={handlePlayAll}
          disabled={!tracks.length}
          style={{
            padding: "10px 24px",
            background: "var(--accent)",
            color: "#fff",
            borderRadius: "var(--radius-sm)",
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <Play size={18} fill="#fff" />
          <span>Putar Semua</span>
        </button>

        <button
          onClick={() => onDeletePlaylist?.(playlist.id)}
          style={{
            padding: "10px 16px",
            background: "var(--bg-secondary)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            color: "var(--error)",
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Trash2 size={16} /> Hapus Playlist
        </button>
      </div>

      {/* Tracks List */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {tracks.map((t, index) => (
          <div
            key={t.id}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 16px",
              background: "var(--bg-secondary)",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
              <span style={{ width: 24, fontSize: 12, color: "var(--fg-muted)", textAlign: "center" }}>
                {index + 1}
              </span>
              <img
                src={t.cover_url || (t.cover_path ? `/api/library/tracks/${t.id}/cover` : "https://placehold.co/40x40?text=Audio")}
                alt={t.title}
                style={{ width: 40, height: 40, borderRadius: 4, objectFit: "cover" }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {t.title}
                </div>
                <div style={{ fontSize: 12, color: "var(--fg-secondary)" }}>
                  {t.artist || "Unknown"} • {formatDuration(t.duration_ms)}
                </div>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button
                onClick={() => api.addToQueue([t.id])}
                title="Putar Sekarang"
                style={{ padding: 6, color: "var(--fg-secondary)" }}
              >
                <Play size={16} />
              </button>
              <button
                onClick={() => handleRemoveTrack(t.id)}
                title="Hapus dari Playlist"
                style={{ padding: 6, color: "var(--error)" }}
              >
                <Trash2 size={16} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
