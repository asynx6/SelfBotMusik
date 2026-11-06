import React, { useState } from "react";
import {
  Compass,
  Library,
  ListMusic,
  Heart,
  History,
  Download,
  Settings as SettingsIcon,
  LogOut,
  FolderPlus
} from "lucide-react";
import { api } from "../services/api";

export default function Sidebar({
  currentTab,
  setCurrentTab,
  playlists = [],
  onNewPlaylist,
  isMobile = false,
  isOpen = false,
  onClose,
}) {
  const handleLogout = async () => {
    try {
      await api.logout();
      window.location.href = "/login";
    } catch (e) {
      console.error(e);
    }
  };

  // On mobile the sidebar is an off-canvas drawer, so picking a destination
  // must also dismiss it.
  const selectTab = (id) => {
    setCurrentTab(id);
    if (isMobile) onClose?.();
  };

  const drawerStyle = {
    position: "fixed",
    top: 0,
    bottom: 0,
    left: 0,
    zIndex: 300,
    width: 272,
    height: "100dvh",
    transform: isOpen ? "translateX(0)" : "translateX(-100%)",
    transition: "transform 220ms cubic-bezier(0.16, 1, 0.3, 1)",
    boxShadow: isOpen ? "0 0 48px rgba(0, 0, 0, 0.65)" : "none",
  };

  const navItems = [
    { id: "discover", label: "Pencarian", icon: Compass },
    { id: "queue", label: "Antrian Putar", icon: ListMusic },
    { id: "library", label: "Perpustakaan", icon: Library },
    { id: "likes", label: "Lagu Disukai", icon: Heart },
    { id: "history", label: "Riwayat Putar", icon: History },
    { id: "downloads", label: "Unduhan", icon: Download },
    { id: "settings", label: "Pengaturan", icon: SettingsIcon },
  ];

  return (
    <>
      {isMobile && isOpen ? (
        <div
          onClick={onClose}
          aria-hidden="true"
          style={{ position: "fixed", inset: 0, background: "rgba(0, 0, 0, 0.55)", zIndex: 299 }}
        />
      ) : null}
      <div style={{
      width: 240,
      background: "var(--bg-secondary)",
      borderRight: "1px solid var(--border)",
      display: "flex",
      flexDirection: "column",
      height: "100%",
      padding: "20px 16px",
      flexShrink: 0,
      ...(isMobile ? drawerStyle : null),
    }}>
      {/* Brand Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, paddingBottom: 24, borderBottom: "1px solid var(--border)" }}>
        <div style={{
          width: 32,
          height: 32,
          borderRadius: "var(--radius-sm)",
          background: "var(--accent)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: 800,
          color: "#fff",
          fontSize: 16,
        }}>
          S
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16, color: "var(--fg-primary)", letterSpacing: "-0.5px" }}>SelfBotMusic</div>
        </div>
      </div>

      {/* Main Navigation */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 16 }}>
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = currentTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => selectTab(item.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 12px",
                borderRadius: "var(--radius-sm)",
                background: active ? "var(--bg-hover)" : "transparent",
                color: active ? "var(--accent)" : "var(--fg-secondary)",
                fontWeight: active ? 600 : 400,
                textAlign: "left",
                transition: "all var(--transition)",
              }}
            >
              <Icon size={18} color={active ? "var(--accent)" : "var(--fg-secondary)"} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>

      {/* Playlists section */}
      <div style={{ marginTop: 24, flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, padding: "0 8px" }}>
          <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--fg-muted)", fontWeight: 700 }}>
            Playlist
          </span>
          <button
            onClick={onNewPlaylist}
            title="Buat Playlist Baru"
            style={{ color: "var(--fg-muted)", padding: 2 }}
          >
            <FolderPlus size={16} />
          </button>
        </div>

        <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 2, flex: 1 }}>
          {playlists.map((p) => {
            const active = currentTab === `playlist:${p.id}`;
            return (
              <button
                key={p.id}
                onClick={() => selectTab(`playlist:${p.id}`)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "8px 12px",
                  borderRadius: "var(--radius-sm)",
                  background: active ? "var(--bg-hover)" : "transparent",
                  color: active ? "var(--accent)" : "var(--fg-secondary)",
                  fontSize: 13,
                  textAlign: "left",
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>{p.track_count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Logout */}
      <div style={{ paddingTop: 16, borderTop: "1px solid var(--border)" }}>
        <button
          onClick={handleLogout}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "8px 12px",
            width: "100%",
            color: "var(--fg-muted)",
            fontSize: 13,
          }}
        >
          <LogOut size={16} />
          <span>Keluar</span>
        </button>
      </div>
      </div>
    </>
  );
}
