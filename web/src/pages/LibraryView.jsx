import React, { useState, useEffect } from "react";
import { Play, Plus, Trash2, Heart, Upload, HardDrive, RefreshCw } from "lucide-react";
import { api } from "../services/api";

function formatDuration(ms) {
  if (!ms) return "0:00";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec < 10 ? "0" : ""}${sec}`;
}

export default function LibraryView({ onNotification }) {
  const [tracks, setTracks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [uploading, setUploading] = useState(false);

  const loadTracks = async () => {
    setLoading(true);
    try {
      const data = await api.getTracks({ filter, limit: 100 });
      setTracks(data.tracks || []);
    } catch (err) {
      onNotification?.("error", err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTracks();
  }, [filter]);

  const handlePlay = async (track) => {
    try {
      await api.addToQueue([track.id]);
      onNotification?.("success", `Memutar: ${track.title}`);
    } catch (err) {
      onNotification?.("error", err.message);
    }
  };

  const handlePlayNext = async (track) => {
    try {
      await api.playNext([track.id]);
      onNotification?.("success", `Putar setelah ini: ${track.title}`);
    } catch (err) {
      onNotification?.("error", err.message);
    }
  };

  const handleDeleteFile = async (track) => {
    if (!confirm(`Hapus file lokal untuk "${track.title}"? (Metadata tetap tersimpan)`)) return;
    try {
      await api.deleteTrackFile(track.id);
      onNotification?.("success", "File lokal dihapus");
      loadTracks();
    } catch (err) {
      onNotification?.("error", err.message);
    }
  };

  const handleDeleteTrack = async (track) => {
    if (!confirm(`Hapus permanen lagu "${track.title}" dari library?`)) return;
    try {
      await api.deleteTrack(track.id);
      onNotification?.("success", "Lagu dihapus dari library");
      loadTracks();
    } catch (err) {
      onNotification?.("error", err.message);
    }
  };

  const handleToggleLike = async (track) => {
    try {
      const r = await api.toggleLike(track.id);
      onNotification?.("success", r.liked ? "Ditambahkan ke Disukai" : "Dihapus dari Disukai");
    } catch (err) {
      onNotification?.("error", err.message);
    }
  };

  const handleFileUpload = async (e) => {
    const files = e.target.files;
    if (!files || !files.length) return;

    setUploading(true);
    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append("files", files[i]);
    }

    try {
      const res = await fetch("/api/library/upload", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload gagal");
      onNotification?.("success", `${data.tracks?.length || 0} lagu berhasil diunggah`);
      loadTracks();
    } catch (err) {
      onNotification?.("error", err.message);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  return (
    <div style={{ padding: "28px 32px", overflowY: "auto", flex: 1 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700 }}>Library Musik</h1>
          <p style={{ color: "var(--fg-secondary)", fontSize: 13 }}>{tracks.length} lagu tersimpan di database</p>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {/* Upload Button */}
          <label style={{
            padding: "8px 16px",
            background: "var(--accent)",
            color: "#fff",
            borderRadius: "var(--radius-sm)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            cursor: "pointer",
            fontWeight: 600,
            fontSize: 13,
          }}>
            <Upload size={16} />
            <span>{uploading ? "Mengunggah..." : "Unggah Audio"}</span>
            <input
              type="file"
              multiple
              accept="audio/*"
              disabled={uploading}
              onChange={handleFileUpload}
              style={{ display: "none" }}
            />
          </label>

          <button
            onClick={loadTracks}
            title="Muat Ulang"
            style={{ padding: "8px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", color: "var(--fg-secondary)" }}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {/* Filter Tabs */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {["all", "local", "reference"].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              padding: "6px 14px",
              borderRadius: "var(--radius-sm)",
              fontSize: 13,
              background: filter === f ? "var(--bg-hover)" : "var(--bg-secondary)",
              color: filter === f ? "var(--accent)" : "var(--fg-secondary)",
              border: "1px solid var(--border)",
              fontWeight: filter === f ? 600 : 400,
            }}
          >
            {f === "all" ? "Semua Lagu" : f === "local" ? "Hanya Lokal (Disk)" : "Hanya Referensi"}
          </button>
        ))}
      </div>

      {/* Track List */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {tracks.map((t) => (
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
              <img
                src={t.cover_url || (t.cover_path ? `/api/library/tracks/${t.id}/cover` : "https://placehold.co/40x40?text=Audio")}
                alt={t.title}
                style={{ width: 40, height: 40, borderRadius: 4, objectFit: "cover" }}
              />

              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {t.title}
                </div>
                <div style={{ fontSize: 12, color: "var(--fg-secondary)", display: "flex", gap: 8, alignItems: "center" }}>
                  <span>{t.artist || "Unknown"}</span>
                  <span>•</span>
                  <span>{formatDuration(t.duration_ms)}</span>
                  {t.file_path && (
                    <>
                      <span>•</span>
                      <span style={{ color: "var(--success)", display: "flex", alignItems: "center", gap: 4 }}>
                        <HardDrive size={12} /> Lokal
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button
                onClick={() => handleToggleLike(t)}
                title="Sukai Lagu"
                style={{ padding: 6, color: "var(--fg-secondary)" }}
              >
                <Heart size={16} />
              </button>

              <button
                onClick={() => handlePlayNext(t)}
                title="Putar Setelah Ini"
                style={{ padding: 6, color: "var(--fg-secondary)" }}
              >
                <Plus size={16} />
              </button>

              <button
                onClick={() => handlePlay(t)}
                title="Putar Sekarang"
                style={{
                  padding: "6px 14px",
                  background: "var(--accent)",
                  borderRadius: "var(--radius-sm)",
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 12,
                  fontWeight: 600
                }}
              >
                <Play size={14} fill="#fff" />
                <span>Putar</span>
              </button>

              {t.file_path && (
                <button
                  onClick={() => handleDeleteFile(t)}
                  title="Hapus file fisik (pertahankan metadata)"
                  style={{ padding: 6, color: "var(--fg-muted)" }}
                >
                  <HardDrive size={16} />
                </button>
              )}

              <button
                onClick={() => handleDeleteTrack(t)}
                title="Hapus lagu permanen"
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
