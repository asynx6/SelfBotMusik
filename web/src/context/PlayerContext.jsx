import React, { createContext, useContext, useState, useEffect } from "react";
import { api } from "../services/api";

const PlayerContext = createContext(null);

export function PlayerProvider({ children }) {
  const [state, setState] = useState({
    connected: false,
    botReady: false,
    voiceConnected: false,
    playing: null,
    queue: [],
    paused: false,
    volume: 100,
    position: 0,
    voiceChannelId: "",
    guildId: "",
    lastError: null,
    loop: 0,
    needsSetup: false,
  });

  const [wsConnected, setWsConnected] = useState(false);

  useEffect(() => {
    // Initial state fetch
    api.getState()
      .then((data) => setState((prev) => ({ ...prev, ...data })))
      .catch((err) => console.error("Failed to fetch initial state:", err));

    // Connect WebSocket
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}`;

    let ws = null;
    let reconnectTimeout = null;

    function connectWs() {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        setWsConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === "state" && payload.data) {
            setState((prev) => ({ ...prev, ...payload.data }));
          }
        } catch (err) {
          console.error("WS message parse error:", err);
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        reconnectTimeout = setTimeout(connectWs, 2000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connectWs();

    return () => {
      if (ws) ws.close();
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
    };
  }, []);

  return (
    <PlayerContext.Provider value={{ state, wsConnected, setState }}>
      {children}
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  return useContext(PlayerContext);
}
