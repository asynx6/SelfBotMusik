import React, { useState } from "react";
import { Download, Loader2, Check } from "lucide-react";
import { api } from "../services/api";

/**
 * Shared "Unduh" action for every track list (Perpustakaan, Disukai, Riwayat,
 * Playlist, Cari & Temukan, Antrian Putar). Downloads use yt-dlp against the
 * URL already stored in the library row, so they work with OR without Lavalink.
 */
export default function DownloadButton({ trackId, downloaded = false, onNotification, compact = false }) {
  const [busy, setBusy] = useState(false);

  if (downloaded) {
    return (
      <span
        title="Sudah tersimpan di disk"
        style={{
          padding: compact ? 6 : "6px 10px",
          fontSize: 12,
          color: "var(--success)",
          display: "flex",
          alignItems: "center",
          gap: 4,
          background: "rgba(0, 200, 83, 0.1)",
          borderRadius: "var(--radius-sm)",
        }}
      >
        <Check size={14} /> {!compact && "Tersimpan"}
      </span>
    );
  }

  const title = "Unduh lagu ini ke disk";

  const handleClick = async (e) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await api.enqueueDownload([trackId]);
      onNotification?.("success", "Unduhan ditambahkan ke antrian");
    } catch (err) {
      onNotification?.("error", err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      title={title}
      aria-label={title}
      style={{
        padding: compact ? 6 : "6px 10px",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        display: "flex",
        alignItems: "center",
        gap: 5,
        color: "var(--fg-secondary)",
        fontSize: 12,
        opacity: busy ? 0.5 : 1,
        cursor: busy ? "not-allowed" : "pointer",
      }}
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
      {!compact && <span>{busy ? "Menambahkan..." : "Unduh"}</span>}
    </button>
  );
}
