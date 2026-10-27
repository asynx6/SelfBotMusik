import React, { useState, useEffect } from "react";
import { Settings as SettingsIcon, Save, Radio, Power } from "lucide-react";
import { api } from "../services/api";

export default function SettingsView({ onNotification }) {
  const [config, setConfig] = useState({
    guildId: "",
    channelId: "",
    lavaHost: "",
    lavaPort: 80,
    lavaPass: "",
    lavaSecure: false,
  });

  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getConfig()
      .then((data) => setConfig((prev) => ({ ...prev, ...data })))
      .catch((e) => onNotification?.("error", e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (e) => {
    e.preventDefault();
    try {
      await api.saveSettings(config);
      onNotification?.("success", "Pengaturan berhasil disimpan");
    } catch (err) {
      onNotification?.("error", err.message);
    }
  };

  const handleConnect = async () => {
    try {
      await api.connect();
      onNotification?.("success", "Bot berhasil terhubung ke Voice Channel");
    } catch (e) {
      onNotification?.("error", e.message);
    }
  };

  const handleDisconnect = async () => {
    try {
      await api.disconnect(true);
      onNotification?.("success", "Bot terputus dari Voice Channel");
    } catch (e) {
      onNotification?.("error", e.message);
    }
  };

  return (
    <div style={{ padding: "28px 32px", overflowY: "auto", flex: 1, maxWidth: 680 }}>
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
          <SettingsIcon size={26} />
        </div>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800 }}>Pengaturan Bot</h1>
          <p style={{ color: "var(--fg-secondary)", fontSize: 13 }}>Konfigurasi Discord Guild & Lavalink Node</p>
        </div>
      </div>

      {/* Voice Channel Actions */}
      <div style={{ display: "flex", gap: 12, marginBottom: 32 }}>
        <button
          onClick={handleConnect}
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
          <Radio size={16} /> Hubungkan ke Voice
        </button>

        <button
          onClick={handleDisconnect}
          style={{
            padding: "10px 20px",
            background: "var(--bg-secondary)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            color: "var(--error)",
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <Power size={16} /> Putuskan Voice
        </button>
      </div>

      <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Guild ID (Discord Server)</label>
          <input
            type="text"
            value={config.guildId}
            onChange={(e) => setConfig({ ...config, guildId: e.target.value })}
            placeholder="Contoh: 924715578151796767"
            style={{ width: "100%" }}
          />
        </div>

        <div>
          <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Voice Channel ID</label>
          <input
            type="text"
            value={config.channelId}
            onChange={(e) => setConfig({ ...config, channelId: e.target.value })}
            placeholder="Contoh: 1500358290918473748"
            style={{ width: "100%" }}
          />
        </div>

        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 14 }}>Konfigurasi Lavalink Node</h2>

          <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Host Lavalink</label>
              <input
                type="text"
                value={config.lavaHost}
                onChange={(e) => setConfig({ ...config, lavaHost: e.target.value })}
                placeholder="lavalinkv4.serenetia.com"
                style={{ width: "100%" }}
              />
            </div>
            <div style={{ width: 120 }}>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Port</label>
              <input
                type="number"
                value={config.lavaPort}
                onChange={(e) => setConfig({ ...config, lavaPort: Number(e.target.value) })}
                style={{ width: "100%" }}
              />
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Password Lavalink</label>
            <input
              type="password"
              value={config.lavaPass}
              onChange={(e) => setConfig({ ...config, lavaPass: e.target.value })}
              placeholder={config.hasLavaPass ? "•••••••• (Tersimpan)" : "Masukkan password"}
              style={{ width: "100%" }}
            />
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 13 }}>
            <input
              type="checkbox"
              checked={config.lavaSecure}
              onChange={(e) => setConfig({ ...config, lavaSecure: e.target.checked })}
              style={{ width: 16, height: 16, accentColor: "var(--accent)" }}
            />
            <span>Gunakan SSL / TLS (Secure WSS)</span>
          </label>
        </div>

        <div style={{ marginTop: 12 }}>
          <button
            type="submit"
            style={{
              padding: "12px 28px",
              background: "var(--accent)",
              color: "#fff",
              borderRadius: "var(--radius-sm)",
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Save size={18} /> Simpan Pengaturan
          </button>
        </div>
      </form>
    </div>
  );
}
