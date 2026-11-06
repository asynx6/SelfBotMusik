import React, { useState, useEffect } from "react";
import { Settings as SettingsIcon, Save, Radio, Power, KeyRound, LogOut } from "lucide-react";
import { api } from "../services/api";
import { usePlayer } from "../context/PlayerContext";

export default function SettingsView({ onNotification }) {
  const { state } = usePlayer();
  const [config, setConfig] = useState({
    guildId: "",
    channelId: "",
    lavaHost: "",
    lavaPort: 80,
    lavaPass: "",
    lavaSecure: false,
    chatRequestsEnabled: false,
  });

  const [loading, setLoading] = useState(true);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);

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

  const handleChangePassword = async (e) => {
    e?.preventDefault();
    if (!currentPw || !newPw) {
      onNotification?.("error", "Kata sandi saat ini dan yang baru wajib diisi");
      return;
    }
    if (newPw.length < 4) {
      onNotification?.("error", "Kata sandi baru minimal 4 karakter");
      return;
    }
    if (newPw !== confirmPw) {
      onNotification?.("error", "Konfirmasi kata sandi tidak cocok");
      return;
    }
    setPwBusy(true);
    try {
      await api.changePassword(currentPw, newPw);
      onNotification?.("success", "Kata sandi berhasil diperbarui");
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
    } catch (err) {
      onNotification?.("error", err.message);
    } finally {
      setPwBusy(false);
    }
  };

  const handleLogout = async () => {
    try {
      await api.logout();
      window.location.href = "/login";
    } catch (err) {
      onNotification?.("error", err.message);
    }
  };

  const pwFieldStyle = { width: "100%" };

  // Live status comes from the WebSocket state (`State.connected`), not from a
  // one-off fetch, so a node that drops while the page is open updates here.
  const lavaConfigured = Boolean(config.lavaHost && config.hasLavaPass);
  const lavaConnected = Boolean(state?.connected);
  const lavaTarget = config.lavaHost
    ? `${config.lavaHost}:${config.lavaPort || 2333}`
    : "host belum diisi";

  const lavaStatus = lavaConnected
    ? {
        color: "var(--success)",
        background: "rgba(0, 200, 83, 0.10)",
        border: "rgba(0, 200, 83, 0.35)",
        title: "Lavalink terhubung",
        detail: `Node ${lavaTarget} aktif. Lagu online dapat diputar.`,
      }
    : lavaConfigured
      ? {
          color: "var(--error)",
          background: "rgba(255, 59, 48, 0.10)",
          border: "rgba(255, 59, 48, 0.35)",
          title: "Lavalink tidak terhubung",
          detail: `Node ${lavaTarget} belum merespons. Lagu yang sudah diunduh tetap bisa diputar offline.`,
        }
      : {
          color: "var(--fg-muted)",
          background: "var(--bg-tertiary)",
          border: "var(--border)",
          title: "Lavalink belum dikonfigurasi",
          detail: "Isi host dan password di bawah lalu Simpan Pengaturan. Mode offline tetap tersedia.",
        };

  return (
    <div className="page-body" style={{ maxWidth: 680 }}>
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

          <div
            role="status"
            aria-live="polite"
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: "10px 12px",
              marginBottom: 16,
              borderRadius: "var(--radius-sm)",
              border: `1px solid ${lavaStatus.border}`,
              background: lavaStatus.background,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                marginTop: 6,
                flexShrink: 0,
                background: lavaStatus.color,
              }}
            />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: lavaStatus.color }}>
                Status Lavalink: {lavaStatus.title}
              </div>
              <div style={{ fontSize: 12, color: "var(--fg-secondary)", lineHeight: 1.5 }}>
                {lavaStatus.detail}
              </div>
            </div>
          </div>

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

        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 14 }}>Fitur Tambahan</h2>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", fontSize: 13 }}>
            <input
              type="checkbox"
              checked={config.chatRequestsEnabled}
              onChange={(e) => setConfig({ ...config, chatRequestsEnabled: e.target.checked })}
              style={{ width: 16, height: 16, marginTop: 2, accentColor: "var(--accent)" }}
            />
            <div>
              <div style={{ fontWeight: 600 }}>Request Musik via Chat Discord</div>
              <div style={{ color: "var(--fg-secondary)", fontSize: 12 }}>
                Pengguna di server Discord dapat me-mention bot untuk memutar lagu (contoh: <code>@bot what if i call</code>). Default dinonaktifkan.
              </div>
            </div>
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

      {/* Account security. Kept outside the settings <form> above so these
          fields cannot submit — or be submitted by — the bot configuration. */}
      <section style={{ borderTop: "1px solid var(--border)", marginTop: 30, paddingTop: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <KeyRound size={18} color="var(--accent)" />
          <h2 style={{ fontSize: 16, fontWeight: 700 }}>Keamanan Akun</h2>
        </div>
        <p style={{ color: "var(--fg-secondary)", fontSize: 12.5, lineHeight: 1.6, marginBottom: 16 }}>
          Ganti kata sandi dashboard. Sesi yang sedang aktif tetap berjalan sampai cookie-nya kedaluwarsa.
        </p>

        <form onSubmit={handleChangePassword} style={{ display: "grid", gap: 10, maxWidth: 360 }}>
          <input
            type="password"
            value={currentPw}
            onChange={(e) => setCurrentPw(e.target.value)}
            placeholder="Kata sandi saat ini"
            autoComplete="current-password"
            style={pwFieldStyle}
          />
          <input
            type="password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            placeholder="Kata sandi baru (min. 4 karakter)"
            autoComplete="new-password"
            style={pwFieldStyle}
          />
          <input
            type="password"
            value={confirmPw}
            onChange={(e) => setConfirmPw(e.target.value)}
            placeholder="Ulangi kata sandi baru"
            autoComplete="new-password"
            style={pwFieldStyle}
          />
          <div style={{ display: "flex", gap: 10, marginTop: 4, flexWrap: "wrap" }}>
            <button
              type="submit"
              disabled={pwBusy}
              style={{
                padding: "10px 18px",
                background: "var(--accent)",
                color: "#fff",
                borderRadius: "var(--radius-sm)",
                fontWeight: 700,
                fontSize: 13,
                display: "flex",
                alignItems: "center",
                gap: 8,
                opacity: pwBusy ? 0.6 : 1,
              }}
            >
              <KeyRound size={16} /> {pwBusy ? "Menyimpan…" : "Ganti Password"}
            </button>
            <button
              type="button"
              onClick={handleLogout}
              style={{
                padding: "10px 18px",
                background: "transparent",
                border: "1px solid var(--border)",
                color: "var(--fg-secondary)",
                borderRadius: "var(--radius-sm)",
                fontWeight: 600,
                fontSize: 13,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <LogOut size={16} /> Keluar
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
