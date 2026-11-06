import React, { useEffect, useRef, useState } from "react";
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
  Radio,
  AlertCircle
} from "lucide-react";
import { usePlayer } from "../context/PlayerContext";
import { useIsMobile } from "../hooks/useMediaQuery";
import { api } from "../services/api";

function formatTime(ms) {
  if (!ms || isNaN(ms)) return "0:00";
  const seconds = Math.floor(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

const VOLUME_MIN = 0;
const VOLUME_MAX = 200;

function clampVolume(value) {
  if (value === null || value === undefined || value === "") return 100;
  const n = Number(value);
  if (!Number.isFinite(n)) return 100;
  return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, Math.round(n)));
}

export default function BottomPlayer() {
  const { state } = usePlayer();
  const isMobile = useIsMobile();
  const current = state.playing;

  const progressPct = current?.duration
    ? Math.min(100, (state.position / current.duration) * 100)
    : 0;

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

  // Volume is a controlled input backed by the WebSocket, so a plain onChange
  // fights the user: the thumb snaps back to the stale server value between
  // round-trips. Keep a local draft and release it once the server agrees.
  const [volumeDraft, setVolumeDraft] = useState(null);
  const [volumeText, setVolumeText] = useState(null);
  const commitTimer = useRef(null);
  const draftTimer = useRef(null);
  const lastAudibleRef = useRef(clampVolume(state.volume));

  const serverVolume = clampVolume(state.volume);
  const displayVolume = volumeDraft ?? serverVolume;
  const volumePct = (displayVolume / VOLUME_MAX) * 100;
  const volumeLabel = volumeText ?? String(displayVolume);

  useEffect(() => {
    if (volumeDraft !== null && serverVolume === volumeDraft) {
      setVolumeDraft(null);
      clearTimeout(draftTimer.current);
    }
  }, [serverVolume, volumeDraft]);

  useEffect(() => {
    if (serverVolume > 0) lastAudibleRef.current = serverVolume;
  }, [serverVolume]);

  useEffect(() => () => {
    clearTimeout(commitTimer.current);
    clearTimeout(draftTimer.current);
  }, []);

  // One writer for the slider, keyboard arrows, numeric field and mute button.
  // The short debounce coalesces a drag into one request while the local draft
  // keeps the thumb responsive instead of waiting for the round-trip.
  const commitVolume = (value) => {
    const next = clampVolume(value);
    setVolumeDraft(next);
    setVolumeText(null);
    if (next > 0) lastAudibleRef.current = next;

    clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      api.setVolume(next).catch((err) => console.error(err));
    }, 90);

    // A lost request must not leave the UI stuck on an unconfirmed value.
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => setVolumeDraft(null), 1500);
  };

  const handleVolumeInput = (e) => commitVolume(e.target.value);

  const handleVolumeNumber = (e) => {
    const raw = e.target.value;
    if (raw.trim() === "") {
      setVolumeText(raw); // mid-edit: keep the field empty, do not commit yet
      return;
    }
    commitVolume(raw);
    setVolumeText(String(clampVolume(raw))); // normalise "001" / "-5" while typing
  };

  const handleVolumeNumberBlur = () => setVolumeText(null);

  const handleToggleMute = () => {
    commitVolume(displayVolume > 0 ? 0 : (lastAudibleRef.current || 100));
  };

  // A track that could not play used to fail silently (the bot just skipped it).
  // Surface the reason so "bot nya ga nyanyi" is explainable instead of mysterious.
  const activeError = state.playbackError || state.lastError;
  const errorBanner = activeError ? (
    <div
      role="alert"
      style={{
        position: "fixed",
        left: 16,
        right: 16,
        bottom: isMobile ? 72 : 92,
        zIndex: 120,
        padding: "10px 14px",
        borderRadius: "var(--radius-sm)",
        background: "rgba(255, 77, 77, 0.12)",
        border: "1px solid rgba(255, 77, 77, 0.35)",
        color: "#ff8f8f",
        fontSize: 12,
        lineHeight: 1.45,
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        pointerEvents: "none",
      }}
    >
      <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>{activeError}</span>
    </div>
  ) : null;

  // Phone layout: one row, primary controls only, progress as a hairline on
  // top. The desktop three-column layout cannot fit under ~900px.
  if (isMobile) {
    return (
      <>
        {errorBanner}
        <div style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        height: 64,
        zIndex: 100,
        background: "var(--bg-secondary)",
        borderTop: "1px solid var(--border)",
      }}>
        <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progressPct)} aria-label="Posisi lagu" style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "var(--border)" }}>
          <div style={{ width: `${progressPct}%`, height: "100%", background: "var(--accent)" }} />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, height: "100%", padding: "0 10px" }}>
          <div style={{
            width: 40,
            height: 40,
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
              <Music2 size={18} color="var(--fg-muted)" />
            )}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {current ? current.title : "Tidak ada yang diputar"}
            </div>
            <div style={{ fontSize: 11, color: "var(--fg-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {current
                ? `${current.author} · ${formatTime(state.position)} / ${formatTime(current.duration)}`
                : "—"}
            </div>
          </div>

          <button
            onClick={handleToggleMute}
            title={displayVolume === 0 ? "Nyalakan Suara" : "Bisukan"}
            aria-label={displayVolume === 0 ? "Nyalakan Suara" : "Bisukan"}
            style={{ padding: 8, flexShrink: 0, color: "var(--fg-secondary)" }}
          >
            {displayVolume === 0 ? <VolumeX size={18} color="var(--error)" /> : <Volume2 size={18} />}
          </button>

          <button
            onClick={handleTogglePlay}
            disabled={!current}
            aria-label={state.paused ? "Lanjutkan" : "Jeda"}
            style={{
              width: 40,
              height: 40,
              borderRadius: "50%",
              flexShrink: 0,
              background: current ? "var(--accent)" : "var(--border)",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {!current || state.paused ? <Play size={18} fill="#fff" /> : <Pause size={18} fill="#fff" />}
          </button>

          <button
            onClick={handleSkip}
            disabled={!current}
            aria-label="Lewati lagu"
            style={{ padding: 8, flexShrink: 0, color: current ? "var(--fg-primary)" : "var(--fg-muted)" }}
          >
            <SkipForward size={20} />
          </button>
        </div>
      </div>
      </>
    );
  }

  return (
    <>
      {errorBanner}
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
            {!current || state.paused ? <Play size={18} fill="#fff" /> : <Pause size={18} fill="#fff" />}
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
          <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progressPct)} aria-label="Posisi lagu" style={{
            flex: 1,
            height: 4,
            background: "var(--border)",
            borderRadius: 2,
            position: "relative",
            overflow: "hidden",
          }}>
            <div style={{
              width: `${progressPct}%`,
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
          <span className="voice-status-label">{state.voiceConnected ? "Terhubung ke Voice" : "Terputus"}</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={handleToggleMute}
            title={displayVolume === 0 ? "Nyalakan Suara" : "Bisukan"}
            aria-label={displayVolume === 0 ? "Nyalakan Suara" : "Bisukan"}
            style={{ padding: 4, display: "flex", color: "var(--fg-secondary)" }}
          >
            {displayVolume === 0 ? (
              <VolumeX size={18} color="var(--error)" />
            ) : (
              <Volume2 size={18} />
            )}
          </button>
          <input
            type="range"
            className="volume-slider"
            min={VOLUME_MIN}
            max={VOLUME_MAX}
            step={1}
            value={displayVolume}
            onChange={handleVolumeInput}
            onKeyDown={() => setVolumeText(null)}
            aria-label="Volume"
            aria-valuemin={VOLUME_MIN}
            aria-valuemax={VOLUME_MAX}
            aria-valuenow={displayVolume}
            aria-valuetext={`${displayVolume}%`}
            title={`Volume ${displayVolume}% — geser, atau fokus lalu tekan ←/→ untuk naik/turun 1%`}
            style={{
              "--volume-fill": `${volumePct}%`,
              "--volume-thumb": displayVolume === 0 ? "var(--fg-muted)" : "var(--accent)",
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 1 }}>
            <input
              className="volume-number"
              type="number"
              min={VOLUME_MIN}
              max={VOLUME_MAX}
              step={1}
              value={volumeLabel}
              onChange={handleVolumeNumber}
              onBlur={handleVolumeNumberBlur}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              aria-label="Nilai volume 0 sampai 200"
              title="Ketik angka 0–200 untuk nilai persis (mis. 1)"
            />
            <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>%</span>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
