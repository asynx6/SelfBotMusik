import React from "react";
import {
  Play,
  Pause,
  SkipForward,
  Square,
  Volume2,
  VolumeX,
  Repeat,
  Shuffle,
  Heart,
  Music2,
  Radio
} from "lucide-react";
import { usePlayer } from "../context/PlayerContext";
import { api } from "../services/api";

function formatTime(ms) {
  if (!ms || isNaN(ms)) return "0:00";
  const seconds = Math.floor(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

export default function BottomPlayer() {
  const { state } = usePlayer();
  const current = state.playing;

  const handleTogglePlay = async () => {
    try {
      await api.pause();
    } catch (e) {
      console.error(e);
    }
  };

  const handleSkip = async () => {
    try {
      await api.skip();
    } catch (e) {
      console.error(e);
    }
  };

  const handleStop = async () => {
    try {
      await api.stop();
    } catch (e) {
      console.error(e);
    }
  };

  const handleCycleLoop = async () => {
    try {
      const nextLoop = (state.loop + 1) % 3;
      await api.setLoop(nextLoop);
    } catch (e) {
      console.error(e);
    }
  };

  const handleShuffle = async () => {
    try {
      await api.shuffleQueue();
    } catch (e) {
      console.error(e);
    }
  };

  const handleVolume = async (e) => {
    try {
      await api.setVolume(Number(e.target.value));
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div style={{
      height: 84,
      background: "var(--bg-secondary)",
      borderTop: "1px solid var(--border)",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 24px",
      position: "fixed",
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 100,
    }}>
      {/* Current Track Info */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, width: "30%", minWidth: 200 }}>
        <div style={{
          width: 52,
          height: 52,
          borderRadius: "var(--radius-sm)",
          background: "var(--bg-tertiary)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          flexShrink: 0,
        }}>
          {current?.thumbnail ? (
            <img src={current.thumbnail} alt={current.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <Music2 size={24} color="var(--fg-muted)" />
          )}
        </div>
        <div style={{ overflow: "hidden" }}>
          <div style={{ fontWeight: 600, color: "var(--fg-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {current ? current.title : "Tidak ada yang diputar"}
          </div>
          <div style={{ fontSize: 12, color: "var(--fg-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {current ? current.author : "—"}
          </div>
        </div>
      </div>

      {/* Playback Controls & Progress Bar */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, width: "40%", maxWidth: 600 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <button
            onClick={handleShuffle}
            title="Acak Antrian"
            style={{ color: "var(--fg-secondary)", padding: 6, borderRadius: "50%" }}
          >
            <Shuffle size={18} />
          </button>

          <button
            onClick={handleTogglePlay}
            disabled={!current}
            title={state.paused ? "Lanjutkan" : "Jeda"}
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              background: current ? "var(--accent)" : "var(--border)",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: current ? "pointer" : "default",
            }}
          >
            {state.paused ? <Play size={18} fill="#fff" /> : <Pause size={18} fill="#fff" />}
          </button>

          <button
            onClick={handleSkip}
            disabled={!current}
            title="Lewati Lagu"
            style={{ color: current ? "var(--fg-primary)" : "var(--fg-muted)", padding: 6 }}
          >
            <SkipForward size={20} />
          </button>

          <button
            onClick={handleStop}
            disabled={!current}
            title="Berhenti & Keluar Voice"
            style={{ color: current ? "var(--fg-secondary)" : "var(--fg-muted)", padding: 6 }}
          >
            <Square size={16} />
          </button>

          <button
            onClick={handleCycleLoop}
            title={`Mode Loop: ${state.loop === 0 ? "OFF" : state.loop === 1 ? "LAGU" : "ANTRIAN"}`}
            style={{
              color: state.loop > 0 ? "var(--accent)" : "var(--fg-secondary)",
              padding: 6,
              position: "relative"
            }}
          >
            <Repeat size={18} />
            {state.loop === 1 && (
              <span style={{ position: "absolute", top: 0, right: 0, fontSize: 9, fontWeight: "bold" }}>1</span>
            )}
          </button>
        </div>

        {/* Progress Timeline */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, width: "100%" }}>
          <span style={{ fontSize: 11, color: "var(--fg-muted)", minWidth: 35, textAlign: "right" }}>
            {formatTime(state.position)}
          </span>
          <div style={{
            flex: 1,
            height: 4,
            background: "var(--border)",
            borderRadius: 2,
            position: "relative",
            overflow: "hidden",
          }}>
            <div style={{
              width: current?.duration ? `${Math.min(100, (state.position / current.duration) * 100)}%` : "0%",
              height: "100%",
              background: "var(--accent)",
              borderRadius: 2,
            }} />
          </div>
          <span style={{ fontSize: 11, color: "var(--fg-muted)", minWidth: 35 }}>
            {formatTime(current?.duration)}
          </span>
        </div>
      </div>

      {/* Volume & Status */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, width: "30%", justifyContent: "flex-end" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: state.voiceConnected ? "var(--success)" : "var(--fg-muted)" }}>
          <Radio size={14} />
          <span>{state.voiceConnected ? "Terhubung ke Voice" : "Terputus"}</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {state.volume === 0 ? (
            <VolumeX size={18} color="var(--fg-muted)" />
          ) : (
            <Volume2 size={18} color="var(--fg-secondary)" />
          )}
          <input
            type="range"
            min="0"
            max="200"
            value={state.volume}
            onChange={handleVolume}
            style={{ width: 90, height: 4, cursor: "pointer", accentColor: "var(--accent)" }}
          />
          <span style={{ fontSize: 11, color: "var(--fg-muted)", width: 28, textAlign: "right" }}>
            {state.volume}%
          </span>
        </div>
      </div>
    </div>
  );
}
