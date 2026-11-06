import React, { useState, useEffect } from "react";
import { Play, Plus, Trash2, Heart, Upload, HardDrive, RefreshCw } from "lucide-react";
import { api } from "../services/api";
import { useDialog } from "../context/DialogContext";
import TrackArt from "../components/TrackArt";
import DownloadButton from "../components/DownloadButton";
import { useIsMobile } from "../hooks/useMediaQuery";

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
  const [likedIds, setLikedIds] = useState(() => new Set());
  const { confirm } = useDialog();
  const isMobile = useIsMobile();

  const loadLikes = async () => {
    try {
      const data = await api.getLikes();
      setLikedIds(new Set((data.tracks || []).map((t) => t.id)));
    } catch {
      /* non-fatal: the like icons just start unset */
    }
  };

  useEffect(() => {
    loadLikes();
  }, []);

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
      await api.playNow([track.id]);
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
    const ok = await confirm({
      title: "Hapus File Lokal",
      message: `File audio untuk "${track.title}" akan dihapus dari disk. Metadata dan riwayatnya tetap tersimpan.`,
      confirmText: "Hapus File",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteTrackFile(track.id);
      onNotification?.("success", "File lokal dihapus");
      loadTracks();
    } catch (err) {
      onNotification?.("error", err.message);
    }
  };

  const handleDeleteTrack = async (track) => {
    const ok = await confirm({
      title: "Hapus Lagu",
      message: `"${track.title}" akan dihapus permanen dari library, termasuk file dan metadatanya.`,
      confirmText: "Hapus Permanen",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteTrack(track.id);
      onNotification?.("success", "Lagu dihapus dari library");
      loadTracks();
    } catch (err) {
      onNotification?.("error", err.message);
    }
  };

  const handleToggleLike = async (track) => {
    const wasLiked = likedIds.has(track.id);

    // Optimistic: flip the icon immediately, reconcile with the server after.
    const apply = (liked) => setLikedIds((prev) => {
      const next = new Set(prev);
      if (liked) next.add(track.id);
      else next.delete(track.id);
      return next;
    });

    apply(!wasLiked);
    try {
      const r = await api.toggleLike(track.id);
      const nowLiked = typeof r?.liked === "boolean" ? r.liked : !wasLiked;
      apply(nowLiked);
      onNotification?.("success", nowLiked ? "Ditambahkan ke Disukai" : "Dihapus dari Disukai");
    } catch (err) {
      apply(wasLiked); // rollback
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
    <div className="page-body">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
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
            whiteSpace: "nowrap",
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

      <p style={{ fontSize: 12, color: "var(--fg-muted)", marginTop: -8, marginBottom: 18, lineHeight: 1.5 }}>
        Lagu tanpa badge <span style={{ color: "var(--success)", fontWeight: 600 }}>Lokal</span> adalah
        referensi hasil pencarian / request: belum punya file di disk dan butuh Lavalink untuk diputar.
        Klik Unduh di halaman Cari &amp; Temukan untuk menjadikannya lagu offline.
      </p>

      {/* Track List */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {tracks.map((t) => (
          <div
            key={t.id}
            style={{
              display: "flex",
              // On phones the four action buttons would squeeze the title into
              // an ellipsis, so the row stacks: info on top, actions below.
              flexDirection: isMobile ? "column" : "row",
              alignItems: isMobile ? "stretch" : "center",
              justifyContent: "space-between",
              gap: isMobile ? 8 : 0,
              padding: "10px 16px",
              background: "var(--bg-secondary)",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
              <TrackArt
                src={t.thumbnail || t.cover_url || (t.cover_path ? `/api/library/tracks/${t.id}/cover` : "")}
                alt={t.title}
              />

              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {t.title}
                </div>
                <div style={{
                  fontSize: 12,
                  color: "var(--fg-secondary)",
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                  overflow: "hidden",
                }}>
                  {/* /api/library/tracks serialises `author`/`duration`, while the
                      raw-row endpoints expose `artist`/`duration_ms`. */}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{t.author || t.artist || "Unknown"}</span>
                  <span>•</span>
                  <span>{formatDuration(t.duration ?? t.duration_ms)}</span>
                  {t.downloaded && (
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

            <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: isMobile ? "flex-end" : "flex-start" }}>
              <button
                onClick={() => handleToggleLike(t)}
                title={likedIds.has(t.id) ? "Hapus dari Disukai" : "Sukai Lagu"}
                aria-pressed={likedIds.has(t.id)}
                style={{
                  padding: 6,
                  color: likedIds.has(t.id) ? "var(--like)" : "var(--fg-secondary)",
                  transition: "color 120ms ease",
                }}
              >
                <Heart
                  size={16}
                  fill={likedIds.has(t.id) ? "var(--like)" : "none"}
                  stroke={likedIds.has(t.id) ? "var(--like)" : "currentColor"}
                />
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

              <DownloadButton
                trackId={t.id}
                downloaded={!!t.downloaded}
                onNotification={onNotification}
                compact
              />

              {t.downloaded && (
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
