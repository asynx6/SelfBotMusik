import React, { useState } from "react";
import { Search, Play, Plus, Loader2 } from "lucide-react";
import { api } from "../services/api";
import TrackArt from "../components/TrackArt";
import DownloadButton from "../components/DownloadButton";

export default function DiscoverView({ onNotification }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    try {
      const data = await api.search(query);
      setResults(data);
    } catch (err) {
      onNotification?.("error", err.message || "Pencarian gagal");
    } finally {
      setLoading(false);
    }
  };

  const handlePlayNow = async (track) => {
    try {
      // Search results are already persisted as library rows, so play that
      // exact track instead of searching again by title.
      await api.playNow([track.id]);
      onNotification?.("success", `Memutar: ${track.title}`);
    } catch (err) {
      onNotification?.("error", err.message);
    }
  };

  const handleAddToQueue = async (track) => {
    try {
      await api.addToQueue([track.id]);
      onNotification?.("success", `Ditambahkan ke antrian: ${track.title}`);
    } catch (err) {
      onNotification?.("error", err.message);
    }
  };

  return (
    <div className="page-body">
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 20 }}>Cari & Temukan Musik</h1>

      <form onSubmit={handleSearch} style={{ display: "flex", gap: 12, marginBottom: 32, maxWidth: 640 }}>
        <div style={{ position: "relative", flex: 1 }}>
          <Search size={18} style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--fg-muted)" }} />
          <input
            type="text"
            placeholder="Ketik judul lagu, artis, atau URL YouTube..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: "100%", paddingLeft: 42, height: 44, borderRadius: "var(--radius-md)" }}
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          style={{
            padding: "0 24px",
            background: "var(--accent)",
            color: "#fff",
            borderRadius: "var(--radius-md)",
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {loading ? <Loader2 size={18} className="animate-spin" /> : "Cari"}
        </button>
      </form>

      {/* Results List */}
      <div>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--fg-secondary)", marginBottom: 12 }}>
          {results.length > 0 ? `Hasil Pencarian (${results.length})` : "Belum ada pencarian"}
        </h2>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {results.map((track) => {
            return (
              <div
                key={track.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "12px 16px",
                  background: "var(--bg-secondary)",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border)",
                  transition: "all var(--transition)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 14, flex: 1, minWidth: 0 }}>
                  <TrackArt src={track.thumbnail} alt={track.title} size={48} radius={6} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {track.title}
                    </div>
                    <div style={{ fontSize: 13, color: "var(--fg-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {track.author}
                    </div>
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <DownloadButton
                    trackId={track.id}
                    downloaded={!!track.downloaded}
                    onNotification={onNotification}
                  />

                  <button
                    onClick={() => handleAddToQueue(track)}
                    title="Tambah ke Antrian"
                    style={{
                      padding: "8px 12px",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-sm)",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      color: "var(--fg-secondary)",
                      fontSize: 13,
                    }}
                  >
                    <Plus size={14} />
                    <span>Antrian</span>
                  </button>

                  <button
                    onClick={() => handlePlayNow(track)}
                    title="Putar Sekarang"
                    style={{
                      padding: "8px 16px",
                      background: "var(--accent)",
                      borderRadius: "var(--radius-sm)",
                      color: "#fff",
                      fontWeight: 600,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 13,
                    }}
                  >
                    <Play size={14} fill="#fff" />
                    <span>Putar</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
