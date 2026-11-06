import React, { useState, useEffect } from "react";
import { Play, Heart, Trash2 } from "lucide-react";
import { api } from "../services/api";
import TrackArt from "../components/TrackArt";
import DownloadButton from "../components/DownloadButton";

function formatDuration(ms) {
  if (!ms) return "0:00";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec < 10 ? "0" : ""}${sec}`;
}

export default function LikesView({ onNotification }) {
  const [tracks, setTracks] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadLikes = async () => {
    try {
      const data = await api.getLikes();
      setTracks(data.tracks || []);
    } catch (e) {
      onNotification?.("error", e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLikes();
  }, []);

  const handleUnlike = async (id) => {
    try {
      await api.toggleLike(id);
      loadLikes();
    } catch (e) {
      onNotification?.("error", e.message);
    }
  };

  const handlePlayAll = async () => {
    if (!tracks.length) return;
    try {
      await api.playNow(tracks.map((t) => t.id));
      onNotification?.("success", `Memutar ${tracks.length} lagu disukai`);
    } catch (e) {
      onNotification?.("error", e.message);
    }
  };

  return (
    <div className="page-body">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{
            width: 64,
            height: 64,
            borderRadius: "var(--radius-md)",
            background: "linear-gradient(135deg, #ff416c, #ff4b2b)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
          }}>
            <Heart size={32} fill="#fff" />
          </div>
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 800 }}>Lagu yang Disukai</h1>
            <p style={{ color: "var(--fg-secondary)", fontSize: 13 }}>{tracks.length} lagu favorit Anda</p>
          </div>
        </div>

        {tracks.length > 0 && (
          <button
            onClick={handlePlayAll}
            style={{
              padding: "10px 20px",
              background: "var(--accent)",
              color: "#fff",
              borderRadius: "var(--radius-sm)",
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Play size={16} fill="#fff" /> Putar Semua
          </button>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {tracks.map((t, idx) => (
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
              <span style={{ width: 20, fontSize: 12, color: "var(--fg-muted)", textAlign: "center" }}>
                {idx + 1}
              </span>
              <TrackArt
                src={t.thumbnail || t.cover_url || (t.cover_path ? `/api/library/tracks/${t.id}/cover` : "")}
                alt={t.title}
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

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <DownloadButton
                trackId={t.id}
                downloaded={!!t.file_path}
                onNotification={onNotification}
                compact
              />
              <button
                onClick={async () => {
                  try {
                    await api.playNow([t.id]);
                  } catch (e) {
                    onNotification?.("error", e.message);
                  }
                }}
                title="Putar Sekarang"
                style={{ padding: 6, color: "var(--fg-secondary)" }}
              >
                <Play size={16} />
              </button>
              <button
                onClick={() => handleUnlike(t.id)}
                title="Hapus dari Disukai"
                style={{ padding: 6, color: "var(--accent)" }}
              >
                <Heart size={16} fill="var(--accent)" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
