import React, { useState, useEffect } from "react";
import { History as HistoryIcon, Play, Clock } from "lucide-react";
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

export default function HistoryView({ onNotification }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadHistory = async () => {
    try {
      const data = await api.getHistory();
      setItems(data.history || []);
    } catch (e) {
      onNotification?.("error", e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadHistory();
  }, []);

  return (
    <div className="page-body">
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 24 }}>
        <div style={{
          width: 52,
          height: 52,
          borderRadius: "var(--radius-md)",
          background: "var(--bg-secondary)",
          border: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--accent)",
        }}>
          <HistoryIcon size={26} />
        </div>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800 }}>Riwayat Pemutaran</h1>
          <p style={{ color: "var(--fg-secondary)", fontSize: 13 }}>{items.length} riwayat lagu terakhir</p>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((item) => (
          <div
            key={item.history_id}
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
              <TrackArt
                src={item.thumbnail || item.cover_url || (item.cover_path ? `/api/library/tracks/${item.id}/cover` : "")}
                alt={item.title}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {item.title}
                </div>
                <div style={{ fontSize: 12, color: "var(--fg-secondary)" }}>
                  {item.artist || "Unknown"} • {new Date(item.played_at).toLocaleString()}
                </div>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <DownloadButton
                trackId={item.id}
                downloaded={!!item.file_path}
                onNotification={onNotification}
                compact
              />
              <button
                onClick={async () => {
                  try {
                    await api.playNow([item.id]);
                  } catch (e) {
                    onNotification?.("error", e.message);
                  }
                }}
                title="Putar Lagi"
                style={{ padding: 8, color: "var(--fg-secondary)" }}
              >
                <Play size={16} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
