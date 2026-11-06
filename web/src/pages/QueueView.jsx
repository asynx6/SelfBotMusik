import React, { useState } from "react";
import { Play, Trash2, ArrowUp, ArrowDown, Shuffle, Music, Layers } from "lucide-react";
import { usePlayer } from "../context/PlayerContext";
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

export default function QueueView({ onNotification }) {
  const { state } = usePlayer();
  const queue = state.queue || [];

  const handleClear = async () => {
    try {
      await api.clearQueue();
      onNotification?.("success", "Antrian dibersihkan");
    } catch (e) {
      onNotification?.("error", e.message);
    }
  };

  const handleShuffle = async () => {
    try {
      await api.shuffleQueue();
      onNotification?.("success", "Antrian diacak");
    } catch (e) {
      onNotification?.("error", e.message);
    }
  };

  const handleRemove = async (index) => {
    try {
      await api.removeFromQueue(index);
      onNotification?.("success", "Lagu dihapus dari antrian");
    } catch (e) {
      onNotification?.("error", e.message);
    }
  };

  const handleMove = async (fromIndex, toIndex) => {
    try {
      await api.reorderQueue(fromIndex, toIndex);
    } catch (e) {
      onNotification?.("error", e.message);
    }
  };

  const handleJump = async (index) => {
    try {
      await api.jumpQueue(index);
    } catch (e) {
      onNotification?.("error", e.message);
    }
  };

  return (
    <div className="page-body">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700 }}>Antrian Putar</h1>
          <p style={{ color: "var(--fg-secondary)", fontSize: 13 }}>{queue.length} lagu di antrian</p>
          <p style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>
            Hanya lagu yang sedang diputar dan yang menunggu. Saat antrian habis,
            autoplay menyiapkan lagu serupa lebih dulu — lagu yang Anda tambahkan tetap diprioritaskan.
          </p>
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={handleShuffle}
            disabled={queue.length <= 2}
            style={{
              padding: "8px 16px",
              background: "var(--bg-secondary)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
            }}
          >
            <Shuffle size={16} /> Acak
          </button>
          <button
            onClick={handleClear}
            disabled={queue.length <= 1}
            style={{
              padding: "8px 16px",
              background: "var(--bg-secondary)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              display: "flex",
              alignItems: "center",
              gap: 8,
              color: "var(--error)",
              fontSize: 13,
            }}
          >
            <Trash2 size={16} /> Bersihkan
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {queue.map((item, idx) => {
          const isCurrent = idx === 0 && state.playing;
          return (
            <div
              key={idx}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 16px",
                background: isCurrent ? "var(--bg-hover)" : "var(--bg-secondary)",
                borderRadius: "var(--radius-sm)",
                border: isCurrent ? "1px solid var(--accent)" : "1px solid var(--border)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
                <span style={{
                  width: 24,
                  fontSize: 12,
                  color: isCurrent ? "var(--accent)" : "var(--fg-muted)",
                  fontWeight: 600,
                  textAlign: "center"
                }}>
                  {isCurrent ? <Play size={14} fill="var(--accent)" /> : idx + 1}
                </span>

                <TrackArt src={item.thumbnail} alt={item.title} />

                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, color: isCurrent ? "var(--accent)" : "var(--fg-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {item.title}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--fg-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {item.author} • {formatDuration(item.duration)} • Oleh: {item.requester}
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {Number.isInteger(item.id) && (
                  <DownloadButton
                    trackId={item.id}
                    downloaded={!!item.downloaded}
                    onNotification={onNotification}
                    compact
                  />
                )}
                {!isCurrent && (
                  <>
                    <button
                      onClick={() => handleJump(idx)}
                      title="Putar Sekarang"
                      style={{ padding: 6, color: "var(--fg-secondary)" }}
                    >
                      <Play size={16} />
                    </button>
                    {idx > 1 && (
                      <button
                        onClick={() => handleMove(idx, idx - 1)}
                        title="Geser Naik"
                        style={{ padding: 6, color: "var(--fg-secondary)" }}
                      >
                        <ArrowUp size={16} />
                      </button>
                    )}
                    {idx < queue.length - 1 && (
                      <button
                        onClick={() => handleMove(idx, idx + 1)}
                        title="Geser Turun"
                        style={{ padding: 6, color: "var(--fg-secondary)" }}
                      >
                        <ArrowDown size={16} />
                      </button>
                    )}
                    <button
                      onClick={() => handleRemove(idx)}
                      title="Hapus dari antrian"
                      style={{ padding: 6, color: "var(--error)" }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
