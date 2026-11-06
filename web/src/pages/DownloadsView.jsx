import React, { useState, useEffect } from "react";
import { Download, Check, X, RefreshCw, AlertCircle, Loader2 } from "lucide-react";
import { api } from "../services/api";

export default function DownloadsView({ onNotification }) {
  const [downloads, setDownloads] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadDownloads = async () => {
    try {
      const data = await api.getDownloads();
      setDownloads(data.downloads || []);
    } catch (err) {
      onNotification?.("error", err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDownloads();
    const interval = setInterval(loadDownloads, 2000);
    return () => clearInterval(interval);
  }, []);

  const handleCancel = async (id) => {
    try {
      await api.cancelDownload(id);
      onNotification?.("success", "Unduhan dibatalkan");
      loadDownloads();
    } catch (err) {
      onNotification?.("error", err.message);
    }
  };

  return (
    <div className="page-body">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700 }}>Antrian Unduhan</h1>
          <p style={{ color: "var(--fg-secondary)", fontSize: 13 }}>Status proses yt-dlp ke disk VPS</p>
        </div>

        <button
          onClick={loadDownloads}
          title="Segarkan"
          style={{ padding: "8px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", color: "var(--fg-secondary)" }}
        >
          <RefreshCw size={16} />
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {downloads.map((d) => {
          const isDone = d.status === "done";
          const isFailed = d.status === "failed";
          const isRunning = d.status === "running";
          const isQueued = d.status === "queued";

          return (
            <div
              key={d.id}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                padding: "14px 16px",
                background: "var(--bg-secondary)",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--border)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {isRunning && <Loader2 size={16} className="animate-spin" color="var(--accent)" />}
                  {isQueued && <Download size={16} color="var(--fg-muted)" />}
                  {isDone && <Check size={16} color="var(--success)" />}
                  {isFailed && <AlertCircle size={16} color="var(--error)" />}

                  <span style={{ fontWeight: 600 }}>Track ID #{d.track_id}</span>
                  <span style={{
                    fontSize: 11,
                    textTransform: "uppercase",
                    padding: "2px 6px",
                    borderRadius: 4,
                    background: isDone ? "rgba(0, 200, 83, 0.15)" : isFailed ? "rgba(255, 59, 48, 0.15)" : "var(--bg-tertiary)",
                    color: isDone ? "var(--success)" : isFailed ? "var(--error)" : "var(--fg-secondary)",
                    fontWeight: 700,
                  }}>
                    {d.status}
                  </span>
                </div>

                {(isRunning || isQueued) && (
                  <button
                    onClick={() => handleCancel(d.id)}
                    title="Batalkan Unduhan"
                    style={{ padding: 4, color: "var(--error)" }}
                  >
                    <X size={16} />
                  </button>
                )}
              </div>

              {/* Progress Bar */}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1, height: 4, background: "var(--border)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{
                    width: `${Math.round((d.progress || 0) * 100)}%`,
                    height: "100%",
                    background: isFailed ? "var(--error)" : "var(--accent)",
                  }} />
                </div>
                <span style={{ fontSize: 11, color: "var(--fg-muted)", minWidth: 32, textAlign: "right" }}>
                  {Math.round((d.progress || 0) * 100)}%
                </span>
              </div>

              {d.error && (
                <div style={{ fontSize: 12, color: "var(--error)", background: "rgba(255, 59, 48, 0.08)", padding: "6px 10px", borderRadius: 4 }}>
                  {d.error}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
