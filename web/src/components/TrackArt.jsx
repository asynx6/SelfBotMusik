import React from "react";
import { Music2 } from "lucide-react";

/**
 * Track artwork with a local fallback.
 *
 * Previously every list fell back to `https://placehold.co/...`, which means a
 * network round-trip per row — slow on mobile and broken entirely when the
 * host has no outbound internet (a common Pterodactyl setup).
 */
export default function TrackArt({ src, alt = "", size = 40, radius = 4, className }) {
  const box = {
    width: size,
    height: size,
    borderRadius: radius,
    flexShrink: 0,
    background: "var(--bg-tertiary)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  };

  if (!src) {
    return (
      <div style={box} className={className} aria-hidden="true">
        <Music2 size={Math.round(size * 0.45)} color="var(--fg-muted)" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      className={className}
      style={{ ...box, objectFit: "cover" }}
    />
  );
}
