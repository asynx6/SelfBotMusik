import React, { useState, useEffect } from "react";
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
import { api } from "./services/api";
import "./styles/global.css";

export default function App() {
  const [currentTab, setCurrentTab] = useState("discover");
  const [playlists, setPlaylists] = useState([]);
  const [notification, setNotification] = useState(null);

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
    const name = prompt("Nama playlist baru:");
    if (!name || !name.trim()) return;
    try {
      await api.createPlaylist(name.trim());
      showNotification("success", `Playlist "${name}" dibuat`);
      loadPlaylists();
    } catch (e) {
      showNotification("error", e.message);
    }
  };

  const handleDeletePlaylist = async (id) => {
    if (!confirm("Hapus playlist ini?")) return;
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
    <PlayerProvider>
      <div style={{ display: "flex", height: "100vh", width: "100vw", overflow: "hidden" }}>
        {/* Sidebar */}
        <Sidebar
          currentTab={currentTab}
          setCurrentTab={setCurrentTab}
          playlists={playlists}
          onNewPlaylist={handleCreatePlaylist}
        />

        {/* Main Content Area */}
        <div style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          paddingBottom: 84, // Space for bottom player
          height: "100%",
          overflow: "hidden",
          position: "relative",
        }}>
          {/* Notification Toast */}
          {notification && (
            <div style={{
              position: "absolute",
              top: 20,
              right: 24,
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
    </PlayerProvider>
  );
}
