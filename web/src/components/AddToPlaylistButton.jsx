import React, { useState, useEffect, useRef } from "react";
import { ListPlus, Check, Loader2 } from "lucide-react";
import { api } from "../services/api";

/**
 * Shared "tambah ke playlist" action for every track list.
 *
 * The playlists API existed with no caller — playlists could be created but
 * never filled. This is that missing UI: one button, one popover, reusable.
 */
export default function AddToPlaylistButton({ trackId, onNotification, compact = false }) {
  const [open, setOpen] = useState(false);
  const [playlists, setPlaylists] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleOpen = async (e) => {
    e.stopPropagation();
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (playlists) return;
    try {
      const data = await api.getPlaylists();
      setPlaylists(data.playlists || []);
    } catch (err) {
      onNotification?.("error", err.message);
      setPlaylists([]);
    }
  };

  const handlePick = async (e, playlist) => {
    e.stopPropagation();
    setBusyId(playlist.id);
    try {
      const r = await api.addTrackToPlaylist(playlist.id, trackId);
      if (r.duplicate) {
        onNotification?.("success", `Sudah ada di "${playlist.name}"`);
      } else {
        onNotification?.("success", `Ditambahkan ke "${playlist.name}"`);
      }
      setOpen(false);
    } catch (err) {
      onNotification?.("error", err.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div ref={boxRef} style={{ position: "relative", display: "flex" }}>
      <button
        onClick={handleOpen}
        title="Tambah ke playlist"
        aria-label="Tambah ke playlist"
        aria-expanded={open}
        style={{
          padding: compact ? 6 : "6px 10px",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          display: "flex",
          alignItems: "center",
          gap: 5,
          color: open ? "var(--accent)" : "var(--fg-secondary)",
          fontSize: 12,
        }}
      >
        <ListPlus size={14} /> {!compact && "Playlist"}
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            right: 0,
            bottom: "calc(100% + 6px)",
            zIndex: 60,
            minWidth: 210,
            maxHeight: 260,
            overflowY: "auto",
            background: "var(--bg-tertiary)",
            border: "1px solid var(--border-hover)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-md)",
            padding: 6,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {playlists === null && (
            <div style={{ padding: "10px 12px", fontSize: 12, color: "var(--fg-muted)", display: "flex", alignItems: "center", gap: 6 }}>
              <Loader2 size={13} className="spin" /> Memuat…
            </div>
          )}

          {playlists !== null && playlists.length === 0 && (
            <div style={{ padding: "10px 12px", fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.5 }}>
              Belum ada playlist. Buat dulu di sidebar.
            </div>
          )}

          {playlists !== null && playlists.map((p) => (
            <button
              key={p.id}
              role="menuitem"
              onClick={(e) => handlePick(e, p)}
              disabled={busyId !== null}
              style={{
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                fontSize: 13,
                color: "var(--fg-primary)",
                textAlign: "left",
              }}
              onMouseEnter={(ev) => { ev.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(ev) => { ev.currentTarget.style.background = "transparent"; }}
            >
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.name}
              </span>
              <span style={{ fontSize: 11, color: "var(--fg-muted)", flexShrink: 0 }}>
                {busyId === p.id ? <Check size={13} /> : `${p.track_count ?? 0}`}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
