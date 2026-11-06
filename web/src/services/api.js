export async function apiFetch(endpoint, options = {}) {
  const defaultHeaders = {
    "Content-Type": "application/json",
  };

  const config = {
    ...options,
    headers: options.body instanceof FormData ? options.headers : { ...defaultHeaders, ...options.headers },
  };

  const res = await fetch(endpoint, config);
  if (res.status === 401) {
    if (!window.location.pathname.startsWith("/login")) {
      window.location.href = "/login";
    }
    throw new Error("Unauthorized");
  }

  const contentType = res.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Request failed");
    }
    return data;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Request failed");
  }
  return res;
}

export const api = {
  // Auth
  getStatus: () => apiFetch("/api/auth/status"),
  login: (password) => apiFetch("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => apiFetch("/api/auth/logout", { method: "POST" }),
  changePassword: (current, next) =>
    apiFetch("/api/auth/change-password", { method: "POST", body: JSON.stringify({ current, next }) }),

  // State & Playback
  getState: () => apiFetch("/api/state"),
  connect: () => apiFetch("/api/connect", { method: "POST" }),
  disconnect: (force = false) => apiFetch("/api/disconnect", { method: "POST", body: JSON.stringify({ force }) }),
  play: (query) => apiFetch("/api/play", { method: "POST", body: JSON.stringify({ query }) }),
  skip: () => apiFetch("/api/skip", { method: "POST" }),
  stop: () => apiFetch("/api/stop", { method: "POST" }),
  pause: () => apiFetch("/api/pause", { method: "POST" }),
  setVolume: (volume) => apiFetch("/api/volume", { method: "POST", body: JSON.stringify({ volume }) }),
  setLoop: (mode) => apiFetch("/api/loop", { method: "POST", body: JSON.stringify({ mode }) }),
  clearQueue: () => apiFetch("/api/clear", { method: "POST" }),
  removeFromQueue: (index) => apiFetch(`/api/queue/${index}`, { method: "DELETE" }),
  playNext: (trackIds) => apiFetch("/api/queue/play-next", { method: "POST", body: JSON.stringify({ trackIds }) }),
  playNow: (trackIds) => apiFetch("/api/queue/play-now", { method: "POST", body: JSON.stringify({ trackIds }) }),
  shuffleQueue: () => apiFetch("/api/queue/shuffle", { method: "POST" }),
  reorderQueue: (oldIndex, newIndex) => apiFetch("/api/queue/reorder", { method: "POST", body: JSON.stringify({ oldIndex, newIndex }) }),
  jumpQueue: (index) => apiFetch("/api/queue/jump", { method: "POST", body: JSON.stringify({ index }) }),

  // Search & Library
  search: (query) => apiFetch("/api/search", { method: "POST", body: JSON.stringify({ query }) }),
  getTracks: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return apiFetch(`/api/library/tracks?${query}`);
  },
  deleteTrackFile: (id) => apiFetch(`/api/library/tracks/${id}/file`, { method: "DELETE" }),
  deleteTrack: (id) => apiFetch(`/api/library/tracks/${id}`, { method: "DELETE" }),
  addToQueue: (trackIds) => apiFetch("/api/queue/add", { method: "POST", body: JSON.stringify({ trackIds }) }),

  // Downloads
  enqueueDownload: (trackIds) => apiFetch("/api/downloads", { method: "POST", body: JSON.stringify({ trackIds }) }),
  getDownloads: () => apiFetch("/api/downloads"),
  cancelDownload: (id) => apiFetch(`/api/downloads/${id}`, { method: "DELETE" }),

  // Playlists
  getPlaylists: () => apiFetch("/api/playlists"),
  createPlaylist: (name, description) => apiFetch("/api/playlists", { method: "POST", body: JSON.stringify({ name, description }) }),
  getPlaylist: (id) => apiFetch(`/api/playlists/${id}`),
  updatePlaylist: (id, data) => apiFetch(`/api/playlists/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deletePlaylist: (id) => apiFetch(`/api/playlists/${id}`, { method: "DELETE" }),
  getPlaylistTracks: (id) => apiFetch(`/api/playlists/${id}/tracks`),
  addTrackToPlaylist: (id, trackId) => apiFetch(`/api/playlists/${id}/tracks`, { method: "POST", body: JSON.stringify({ trackId }) }),
  removeTrackFromPlaylist: (id, trackId) => apiFetch(`/api/playlists/${id}/tracks/${trackId}`, { method: "DELETE" }),
  reorderPlaylistTracks: (id, trackIdsOrder) => apiFetch(`/api/playlists/${id}/reorder`, { method: "POST", body: JSON.stringify({ trackIdsOrder }) }),

  // Likes & History
  getLikes: () => apiFetch("/api/likes"),
  toggleLike: (trackId) => apiFetch(`/api/likes/${trackId}`, { method: "POST" }),
  isLiked: (trackId) => apiFetch(`/api/likes/${trackId}`),
  getHistory: () => apiFetch("/api/history"),

  // Settings
  getConfig: () => apiFetch("/api/config"),
  saveSettings: (settings) => apiFetch("/api/settings", { method: "POST", body: JSON.stringify(settings) }),
};
