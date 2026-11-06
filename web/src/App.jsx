import React, { useState, useEffect } from "react";
import { Menu } from "lucide-react";
import Sidebar from "./components/Sidebar";
import BottomPlayer from "./components/BottomPlayer";
import DiscoverView from "./pages/DiscoverView";
import QueueView from "./pages/QueueView";
import LibraryView from "./pages/LibraryView";
import DownloadsView from "./pages/DownloadsView";
import LikesView from "./pages/LikesView";
import HistoryView from "./pages/HistoryView";
import SettingsView from "./pages/SettingsView";
import PlaylistDetailView from "./pages/PlaylistDetailView";
import { PlayerProvider } from "./context/PlayerContext";
import { DialogProvider, useDialog } from "./context/DialogContext";
import { useIsMobile } from "./hooks/useMediaQuery";
import { api } from "./services/api";
import "./styles/global.css";

export default function App() {
  return (
    <DialogProvider>
      <PlayerProvider>
        <AppShell />
      </PlayerProvider>
    </DialogProvider>
  );
}

function AppShell() {
  const [currentTab, setCurrentTab] = useState("discover");
  const [playlists, setPlaylists] = useState([]);
  const [notification, setNotification] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isMobile = useIsMobile();
  const { confirm, prompt } = useDialog();

  const loadPlaylists = async () => {
    try {
      const data = await api.getPlaylists();
      setPlaylists(data.playlists || []);
    } catch (e) {
      console.error("Failed to load playlists:", e);
    }
  };

  useEffect(() => {
    loadPlaylists();
  }, []);

  const showNotification = (type, message) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 4000);
  };

  const handleCreatePlaylist = async () => {
    const name = await prompt({
      title: "Playlist Baru",
      label: "Nama playlist",
      message: "Beri nama untuk playlist ini.",
      placeholder: "Contoh: Lagu Santai",
      confirmText: "Buat",
    });
    if (!name) return;
    try {
      await api.createPlaylist(name);
      showNotification("success", `Playlist "${name}" dibuat`);
      loadPlaylists();
    } catch (e) {
      showNotification("error", e.message);
    }
  };

  const handleDeletePlaylist = async (id) => {
    const ok = await confirm({
      title: "Hapus Playlist",
      message: "Playlist ini akan dihapus permanen. Lagu di dalamnya tetap tersimpan di library.",
      confirmText: "Hapus",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deletePlaylist(id);
      showNotification("success", "Playlist dihapus");
      setCurrentTab("discover");
      loadPlaylists();
    } catch (e) {
      showNotification("error", e.message);
    }
  };

  const renderContent = () => {
    if (currentTab.startsWith("playlist:")) {
      const playlistId = Number(currentTab.split(":")[1]);
      return (
        <PlaylistDetailView
          playlistId={playlistId}
          onNotification={showNotification}
          onDeletePlaylist={handleDeletePlaylist}
        />
      );
    }

    switch (currentTab) {
      case "discover":
        return <DiscoverView onNotification={showNotification} />;
      case "queue":
        return <QueueView onNotification={showNotification} />;
      case "library":
        return <LibraryView onNotification={showNotification} />;
      case "downloads":
        return <DownloadsView onNotification={showNotification} />;
      case "likes":
        return <LikesView onNotification={showNotification} />;
      case "history":
        return <HistoryView onNotification={showNotification} />;
      case "settings":
        return <SettingsView onNotification={showNotification} />;
      default:
        return <DiscoverView onNotification={showNotification} />;
    }
  };

  return (
    <div style={{ display: "flex", height: "100dvh", width: "100%", overflow: "hidden" }}>
      {/* Sidebar — permanent column on desktop, off-canvas drawer on mobile */}
      <Sidebar
        currentTab={currentTab}
        setCurrentTab={setCurrentTab}
        playlists={playlists}
        onNewPlaylist={handleCreatePlaylist}
        isMobile={isMobile}
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />

      {/* Main Content Area */}
      <div style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        paddingBottom: isMobile ? 64 : 84, // Space for bottom player
        height: "100%",
        overflow: "hidden",
        position: "relative",
      }}>
        {isMobile ? (
          <header style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 10px",
            flexShrink: 0,
            background: "var(--bg-secondary)",
            borderBottom: "1px solid var(--border)",
          }}>
            <button
              onClick={() => setDrawerOpen(true)}
              aria-label="Buka menu"
              style={{ padding: 8, display: "flex", color: "var(--fg-secondary)" }}
            >
              <Menu size={20} />
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                background: "var(--accent)",
                color: "#fff",
                fontWeight: 800,
                fontSize: 13,
                display: "grid",
                placeItems: "center",
              }}>S</div>
              <span style={{ fontWeight: 700, fontSize: 14 }}>SelfBotMusic</span>
            </div>
          </header>
        ) : null}

        {/* Notification Toast */}
        {notification && (
          <div style={{
            position: "absolute",
            top: isMobile ? 60 : 20,
            left: isMobile ? 12 : undefined,
            right: isMobile ? 12 : 24,
            padding: "10px 18px",
            borderRadius: "var(--radius-sm)",
            background: notification.type === "error" ? "var(--error)" : "var(--success)",
            color: "#fff",
            fontWeight: 600,
            fontSize: 13,
            boxShadow: "var(--shadow-lg)",
            zIndex: 1000,
          }}>
            {notification.message}
          </div>
        )}

        {renderContent()}
      </div>

      {/* Persistent Bottom Player */}
      <BottomPlayer />
    </div>
  );
}
