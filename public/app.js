(() => {
    "use strict";

    const $ = (s) => document.querySelector(s);
    const $$ = (s) => document.querySelectorAll(s);

    function formatTime(ms) {
        if (!ms || ms < 0) ms = 0;
        const total = Math.floor(ms / 1000);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
        return `${m}:${String(s).padStart(2, "0")}`;
    }
    const shorten = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : (s || ""));
    const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    })[c]);

    function fallbackCover() {
        const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'>
            <rect width='200' height='200' fill='%232c3038'/>
            <text x='100' y='130' font-family='Inter' font-size='90' font-weight='700' text-anchor='middle' fill='%2371717a'>♪</text>
        </svg>`;
        return "data:image/svg+xml;utf8," + svg.replace(/\n/g, "").replace(/#/g, "%23");
    }
    const COVER_PLACEHOLDER = fallbackCover();

    const els = {
        statusBadge: $("#statusBadge"),
        statusText: $("#statusText"),
        npCover: $("#npCover"),
        npTitle: $("#npTitle"),
        npAuthor: $("#npAuthor"),
        npRequester: $("#npRequester"),
        npUri: $("#npUri"),
        progressFill: $("#progressFill"),
        curTime: $("#curTime"),
        totalTime: $("#totalTime"),
        nowChip: $("#nowChip"),
        volume: $("#volume"),
        volumeLabel: $("#volumeLabel"),
        queue: $("#queue"),
        queueCount: $("#queueCount"),
        searchForm: $(".search"),
        searchInput: $("#searchInput"),
        searchSubmit: $("#searchSubmit"),
        searchMsg: $("#searchMsg"),
        queueMsg: $("#queueMsg"),
        vcMsg: $("#vcMsg"),
        settingsMsg: $("#settingsMsg"),
        pwMsg: $("#pwMsg"),
        toastHost: $("#toastHost"),
        btnPause: $("#btnPause"),
        btnSkip: $("#btnSkip"),
        btnStop: $("#btnStop"),
        btnClear: $("#btnClear"),
        btnLoop: $("#btnLoop"),
        btnLogout: $("#btnLogout"),
        btnSettings: $("#btnSettings"),
        btnCloseSettings: $("#btnCloseSettings"),
        settingsPanel: $("#settingsPanel"),
        vcStatus: $("#vcStatus"),
        btnConnect: $("#btnConnect"),
        btnDisconnect: $("#btnDisconnect"),
        cfgGuild: $("#cfgGuild"),
        cfgChannel: $("#cfgChannel"),
        cfgLavaHost: $("#cfgLavaHost"),
        cfgLavaPort: $("#cfgLavaPort"),
        cfgLavaPass: $("#cfgLavaPass"),
        cfgLavaSecure: $("#cfgLavaSecure"),
        btnSaveSettings: $("#btnSaveSettings"),
        btnReloadSettings: $("#btnReloadSettings"),
        pwCurrent: $("#pwCurrent"),
        pwNext: $("#pwNext"),
        pwConfirm: $("#pwConfirm"),
        btnChangePassword: $("#btnChangePassword"),
    };

    let state = null;
    let ws = null;
    let wsAttempts = 0;

    // === Inline messages (replaces hover-only error styles). ===
    function setMsg(target, kind, text) {
        if (!target) return;
        if (!text) {
            target.textContent = "";
            target.className = "inline-msg";
            return;
        }
        target.textContent = text;
        target.className = `inline-msg ${kind}`;
    }

    // === API helper. ===
    async function api(url, opts = {}) {
        const res = await fetch(url, {
            headers: { "Content-Type": "application/json" },
            ...opts,
        });
        if (res.status === 401) {
            const data = await res.json().catch(() => ({}));
            if (data.unAuthed && !url.startsWith("/api/auth/")) {
                window.location.assign("/login");
                throw new Error("Session expired — please sign in again");
            }
            throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
    }

    // === Custom modal dialog (replaces browser confirm()) ===
    let modalResolve = null;
    const modalEls = {
        overlay: null,
        title: null,
        body: null,
        cancel: null,
        confirm: null,
    };
    function showModal(title, message, confirmLabel, danger) {
        if (!modalEls.overlay) {
            modalEls.overlay = $("#modalOverlay");
            modalEls.title = $("#modalTitle");
            modalEls.body = $("#modalBody");
            modalEls.cancel = $("#modalCancel");
            modalEls.confirm = $("#modalConfirm");
        }
        if (modalResolve) { modalResolve(false); modalResolve = null; }
        return new Promise((resolve) => {
            modalResolve = resolve;
            modalEls.title.textContent = title;
            modalEls.body.textContent = message;
            modalEls.confirm.textContent = confirmLabel || "OK";
            modalEls.confirm.className = danger ? "btn btn-danger" : "btn btn-primary";
            modalEls.overlay.hidden = false;
            modalEls.confirm.focus();
        });
    }
    function hideModal(result) {
        if (modalEls.overlay) modalEls.overlay.hidden = true;
        if (modalResolve) { modalResolve(result); modalResolve = null; }
    }
    function initModal() {
        if (modalEls.cancel && modalEls.confirm && modalEls.overlay) {
            modalEls.cancel.addEventListener("click", () => hideModal(false));
            modalEls.confirm.addEventListener("click", () => hideModal(true));
            modalEls.overlay.addEventListener("click", (e) => {
                if (e.target === modalEls.overlay) hideModal(false);
            });
            document.addEventListener("keydown", (e) => {
                if (e.key === "Escape" && modalEls.overlay && !modalEls.overlay.hidden) {
                    hideModal(false);
                }
            });
        }
    }

    function toast(text, kind = "ok") {
        const t = document.createElement("div");
        t.className = `toast ${kind}`;
        t.innerHTML = `<span class="dot"></span><span>${escapeHtml(text)}</span>`;
        els.toastHost.appendChild(t);
        setTimeout(() => t.remove(), 3200);
    }

    // === WS ===
    function connectWS() {
        try {
            const proto = location.protocol === "https:" ? "wss:" : "ws:";
            ws = new WebSocket(`${proto}//${location.host}/`);
            ws.onopen = () => {
                wsAttempts = 0;
                if (els.statusBadge) els.statusBadge.classList.remove("err");
            };
            ws.onclose = () => {
                wsAttempts++;
                const delay = Math.min(15000, 500 * Math.pow(2, wsAttempts));
                setTimeout(connectWS, delay);
            };
            ws.onmessage = (e) => {
                try {
                    const msg = JSON.parse(e.data);
                    if (msg.type === "state" && msg.data) applyState(msg.data);
                } catch {}
            };
        } catch { setTimeout(connectWS, 1500); }
    }

    async function pollState() {
        try {
            const res = await fetch("/api/state", { cache: "no-store" });
            if (res.ok) applyState(await res.json());
        } catch {}
    }

    function applyState(s) {
        if (!s) return;
        state = s;
        renderStatus(s);
        renderNowPlaying(s.playing, s.paused, s.position);
        renderQueue(s.queue, s.playing);
        renderControlsLock(s);

        const total = (s.queue?.length || 0);
        els.queueCount.textContent = String(Math.max(0, total - 1));

        if (typeof s.volume === "number") {
            if (document.activeElement !== els.volume) {
                els.volume.value = String(s.volume);
                els.volumeLabel.textContent = `${s.volume}%`;
            }
        }
        if (s.paused !== undefined) setPauseUI(s.paused);
    }

    function renderStatus(s) {
        if (s.botReady && s.connected && s.voiceConnected) {
            els.statusText.textContent = "Connected";
            els.statusBadge.classList.remove("err");
        } else if (s.botReady && s.connected) {
            els.statusText.textContent = "Online · not in VC";
            els.statusBadge.classList.remove("err");
        } else if (s.botReady) {
            els.statusText.textContent = "Online · Lavalink off";
            els.statusBadge.classList.remove("err");
        } else {
            els.statusText.textContent = "Connecting…";
            els.statusBadge.classList.add("err");
        }
        let vcText = "Not in a voice channel";
        if (s.voiceConnected) vcText = `In voice channel ${s.voiceChannelId || ""}`;
        if (s.lastError) vcText += ` — ${s.lastError}`;
        els.vcStatus.textContent = vcText;
        els.vcStatus.classList.toggle("err", !!s.lastError);
    }

    function renderControlsLock(s) {
        const playing = !!(s?.playing && s.playing.encoded);
        const inVoice = !!(s?.voiceConnected);
        const hasPlayer = !!(s?.connected);

        els.btnPause.disabled = !playing;
        els.btnSkip.disabled = !playing;
        els.btnStop.disabled = !hasPlayer;
        els.btnClear.disabled = !playing && !(s?.queue && s.queue.length > 1);

        if (els.btnDisconnect) {
            els.btnDisconnect.disabled = !inVoice || playing;
        }
        if (els.btnConnect) {
            els.btnConnect.disabled = inVoice && hasPlayer;
        }

        // Loop button
        if (els.btnLoop) {
            const mode = Number(s?.loop) || 0;
            const labels = ["OFF", "1×", "ALL"];
            const sublabels = ["Repeat off", "Loop current track", "Loop all tracks"];
            els.btnLoop.dataset.mode = String(mode);
            els.btnLoop.classList.toggle("active", mode > 0);
            const label = els.btnLoop.querySelector(".loop-label");
            if (label) label.textContent = labels[mode] || "OFF";
            const sub = els.btnLoop.querySelector(".loop-sub");
            if (sub) sub.textContent = sublabels[mode] || "Repeat off";
            els.btnLoop.title = sublabels[mode] || "Repeat";
        }
    }

    function renderNowPlaying(p, _paused, _position) {
        if (!p) {
            els.npTitle.textContent = "Nothing playing yet";
            els.npAuthor.textContent = "—";
            els.npRequester.textContent = "requested by: —";
            els.npUri.hidden = true;
            els.npCover.src = COVER_PLACEHOLDER;
            els.progressFill.style.width = "0%";
            els.curTime.textContent = "0:00";
            els.totalTime.textContent = "0:00";
            els.nowChip.hidden = true;
            return;
        }
        els.npTitle.textContent = p.title || "Unknown";
        els.npAuthor.textContent = p.author || "—";
        els.npRequester.textContent = `requested by: ${p.requester || "—"}`;
        els.npCover.src = p.thumbnail || COVER_PLACEHOLDER;
        if (p.uri) {
            els.npUri.href = p.uri;
            els.npUri.textContent = shorten(p.uri, 56);
            els.npUri.hidden = false;
        } else {
            els.npUri.hidden = true;
        }
        const dur = Math.max(0, Number(p.duration) || 0);
        const pos = Math.max(0, Number(_position) || 0);
        const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
        els.progressFill.style.width = `${pct}%`;
        els.curTime.textContent = formatTime(pos);
        els.totalTime.textContent = formatTime(dur);
        els.nowChip.hidden = false;
    }

    function renderQueue(q, playing) {
        els.queue.innerHTML = "";
        if (!q || q.length <= 1) {
            const empty = document.createElement("div");
            empty.className = "q-empty";
            empty.textContent = "Queue is empty. Search above to add tracks.";
            els.queue.appendChild(empty);
            return;
        }
        const frag = document.createDocumentFragment();
        q.forEach((t, i) => {
            if (i === 0) return; // skip currently-playing; shown above
            const row = document.createElement("div");
            row.className = "q-item";
            row.dataset.index = String(i);

            const idx = document.createElement("div");
            idx.className = "q-index";
            idx.textContent = String(i);

            const cover = document.createElement("img");
            cover.className = "q-cover";
            cover.alt = "";
            cover.src = t.thumbnail || COVER_PLACEHOLDER;

            const meta = document.createElement("div");
            meta.className = "q-meta";
            const t1 = document.createElement("div");
            t1.className = "q-title";
            t1.textContent = t.title || "Unknown";
            const t2 = document.createElement("div");
            t2.className = "q-sub";
            t2.textContent = `${t.author || "—"} · ${formatTime(t.duration)} · ${t.requester || "—"}`;
            meta.appendChild(t1);
            meta.appendChild(t2);

            const actions = document.createElement("div");
            actions.className = "q-actions";
            const rm = document.createElement("button");
            rm.className = "btn btn-icon";
            rm.type = "button";
            rm.title = "Remove from queue";
            rm.setAttribute("aria-label", "Remove track");
            rm.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
            rm.addEventListener("click", () => removeAt(i));
            actions.appendChild(rm);

            row.appendChild(idx);
            row.appendChild(cover);
            row.appendChild(meta);
            row.appendChild(actions);
            frag.appendChild(row);
        });
        els.queue.appendChild(frag);
    }

    function setPauseUI(p) {
        // p = paused state. When paused, show PLAY icon (to resume).
        // When playing, show PAUSE icon (to pause).
        const ico = els.btnPause.querySelector(".ic-pause");
        const icp = els.btnPause.querySelector(".ic-play");
        if (ico) ico.style.display = p ? "none" : "block";
        if (icp) icp.style.display = p ? "block" : "none";
        els.btnPause.title = p ? "Resume" : "Pause";
        els.btnPause.setAttribute("aria-label", p ? "Resume" : "Pause");
    }

    // === Actions ===
    async function searchAndEnqueue() {
        const q = els.searchInput.value.trim();
        if (!q) {
            setMsg(els.searchMsg, "err", "Enter a YouTube query or paste a URL first.");
            els.searchInput.focus();
            return;
        }
        els.searchSubmit.disabled = true;
        setMsg(els.searchMsg, "info", "Searching…");
        try {
            const r = await api("/api/play", { method: "POST", body: JSON.stringify({ query: q }) });
            if (r.track?.queued) {
                setMsg(els.searchMsg, "ok",
                    `Added to queue: "${r.track.title}" — position #${(r.track.queuePosition ?? 0) + 1}`);
            } else {
                setMsg(els.searchMsg, "ok", `Now playing: "${r.track?.title}"`);
            }
            await pollState();
        } catch (e) {
            setMsg(els.searchMsg, "err", e.message || "Failed to add track");
        } finally {
            els.searchSubmit.disabled = false;
            els.searchInput.value = "";
        }
    }

    async function removeAt(idx) {
        setMsg(els.queueMsg, "info", "Removing…");
        try {
            const r = await api(`/api/queue/${idx}`, { method: "DELETE" });
            setMsg(els.queueMsg, "ok", `Removed. ${r.remaining ?? 0} tracks left in queue.`);
            await pollState();
        } catch (e) {
            setMsg(els.queueMsg, "err", e.message || "Failed to remove track");
        }
    }

    async function clearQueue() {
        setMsg(els.queueMsg, "info", "Clearing…");
        try {
            const r = await api("/api/clear", { method: "POST" });
            setMsg(els.queueMsg, "ok", `Cleared ${r.cleared ?? 0} upcoming tracks.`);
            await pollState();
        } catch (e) {
            setMsg(els.queueMsg, "err", e.message || "Failed to clear queue");
        }
    }

    async function skip() {
        try {
            const r = await api("/api/skip", { method: "POST" });
            toast(r.remaining != null ? `Skipped (${r.remaining} left)` : "Skipped");
            await pollState();
        } catch (e) { toast(e.message, "err"); }
    }
    async function stop() {
        try {
            await api("/api/stop", { method: "POST" });
            toast("Stopped & left voice channel");
            await pollState();
        } catch (e) { toast(e.message, "err"); }
    }
    async function pause() {
        try {
            const r = await api("/api/pause", { method: "POST" });
            toast(r.paused ? "Paused" : "Resumed");
        } catch (e) { toast(e.message, "err"); }
    }

    // === Settings ===
    async function loadConfigIntoForm() {
        try {
            const r = await api("/api/config");
            els.cfgGuild.value = r.guildId || "";
            els.cfgChannel.value = r.channelId || "";
            els.cfgLavaHost.value = r.lavaHost || "";
            els.cfgLavaPort.value = r.lavaPort || "";
            // Password field: show masked dots when a password is saved in
            // SQLite, empty otherwise. The backend never exposes the real value.
            els.cfgLavaPass.value = r.hasLavaPass ? "••••••••••••" : "";
            els.cfgLavaPass.placeholder = r.hasLavaPass ? "" : "password";
            els.cfgLavaSecure.value = String(!!r.lavaSecure);
        } catch (e) { setMsg(els.settingsMsg, "err", "Could not load config: " + e.message); }
    }
    async function saveSettings() {
        setMsg(els.settingsMsg, "info", "Saving & reconnecting…");
        const body = {
            guildId: els.cfgGuild.value.trim(),
            channelId: els.cfgChannel.value.trim(),
            lavaHost: els.cfgLavaHost.value.trim(),
            lavaPort: Number(els.cfgLavaPort.value) || 2333,
            lavaSecure: els.cfgLavaSecure.value === "true",
        };
        // Only send the password if the user typed a real one (not the masked placeholder).
        const pass = els.cfgLavaPass.value;
        const isMaskedDots = /^[•]{8,}$/.test(pass);
        if (pass && !isMaskedDots) body.lavaPass = pass;
        try {
            const r = await api("/api/settings", { method: "POST", body: JSON.stringify(body) });
            setMsg(els.settingsMsg, "ok", "Saved. Click Connect to join the voice channel.");
        } catch (e) {
            setMsg(els.settingsMsg, "err", e.message || "Failed to save");
        }
    }
    async function connect() {
        setMsg(els.vcMsg, "info", "Connecting to voice…");
        try {
            await api("/api/connect", { method: "POST" });
            setMsg(els.vcMsg, "ok", "Connected.");
            await pollState();
        } catch (e) { setMsg(els.vcMsg, "err", e.message || "Connect failed"); }
    }
    async function disconnect() {
        setMsg(els.vcMsg, "info", "Disconnecting…");
        try {
            await api("/api/disconnect", { method: "POST" });
            setMsg(els.vcMsg, "ok", "Disconnected.");
            await pollState();
        } catch (e) { setMsg(els.vcMsg, "err", e.message || "Disconnect failed"); }
    }
    async function changePassword() {
        const cur = els.pwCurrent.value;
        const nxt = els.pwNext.value;
        const cfm = els.pwConfirm.value;
        setMsg(els.pwMsg, "info", "");
        if (!cur || !nxt || !cfm) { setMsg(els.pwMsg, "err", "All three fields are required."); return; }
        if (nxt !== cfm) { setMsg(els.pwMsg, "err", "New password and confirmation do not match."); return; }
        if (nxt.length < 4) { setMsg(els.pwMsg, "err", "New password must be at least 4 characters."); return; }
        try {
            await api("/api/auth/change-password", {
                method: "POST",
                body: JSON.stringify({ current: cur, next: nxt }),
            });
            setMsg(els.pwMsg, "ok", "Password updated. Use it next time you sign in.");
            els.pwCurrent.value = els.pwNext.value = els.pwConfirm.value = "";
        } catch (e) {
            setMsg(els.pwMsg, "err", e.message || "Failed to change password");
        }
    }

    // === Wire up ===
    function wire() {
        // Buttons
        els.btnPause.addEventListener("click", pause);
        els.btnSkip.addEventListener("click", skip);
        els.btnStop.addEventListener("click", async () => {
            if (!state?.playing?.encoded) {
                // Nothing playing — still confirm before leaving VC
                if (!state?.voiceConnected) return;
                const ok = await showModal("Disconnect from voice?", "You are in a voice channel but nothing is playing. Leave the voice channel?", "Leave VC", true);
                if (ok) stop();
                return;
            }
            const ok = await showModal("Stop playback?", "Stop the music and leave the voice channel? This will also clear the queue.", "Stop & Leave", true);
            if (ok) stop();
        });
        els.btnClear.addEventListener("click", async () => {
            const count = state?.queue?.length ? state.queue.length - 1 : 0;
            if (count <= 0) return;
            const ok = await showModal("Clear queue?", `Remove ${count} upcoming track${count > 1 ? "s" : ""} from the queue? The currently playing track will continue.`, "Clear", true);
            if (ok) clearQueue();
        });
        els.btnLoop.addEventListener("click", async () => {
            try {
                const r = await api("/api/loop", { method: "POST" });
                const labelMap = {
                    OFF: "Repeat: off",
                    TRACK: "Loop current track 🔁",
                    QUEUE: "Loop all tracks 🔁",
                };
                toast(labelMap[r.label] || ("Repeat: " + r.label), "ok");
            } catch (e) { toast(e.message || "Failed to toggle repeat", "err"); }
        });

        if (els.btnLogout) {
            els.btnLogout.addEventListener("click", async () => {
                const ok = await showModal("Sign out?", "You will be logged out of the dashboard and redirected to the login page.", "Sign out", true);
                if (!ok) return;
                try { await api("/api/auth/logout", { method: "POST" }); } catch {}
                window.location.assign("/login");
            });
        }

        if (els.btnChangePassword) {
            els.btnChangePassword.addEventListener("click", async () => {
                const cur = els.pwCurrent.value;
                const nxt = els.pwNext.value;
                const cfm = els.pwConfirm.value;
                if (!cur || !nxt || !cfm) { setMsg(els.pwMsg, "err", "All three fields are required."); return; }
                if (nxt !== cfm) { setMsg(els.pwMsg, "err", "New password and confirmation do not match."); return; }
                if (nxt.length < 4) { setMsg(els.pwMsg, "err", "New password must be at least 4 characters."); return; }
                const ok = await showModal("Change password?", "This will update your dashboard password immediately. You will stay logged in.", "Change password", true);
                if (!ok) return;
                changePassword();
            });
        }

        // Settings
        if (els.btnSettings) {
            els.btnSettings.addEventListener("click", async () => {
                els.settingsPanel.hidden = !els.settingsPanel.hidden;
                if (!els.settingsPanel.hidden) await loadConfigIntoForm();
            });
        }
        if (els.btnCloseSettings) {
            els.btnCloseSettings.addEventListener("click", () => {
                els.settingsPanel.hidden = true;
            });
        }
        if (els.btnSaveSettings) {
            els.btnSaveSettings.addEventListener("click", saveSettings);
        }
        if (els.btnReloadSettings) {
            els.btnReloadSettings.addEventListener("click", loadConfigIntoForm);
        }
        if (els.btnConnect) {
            els.btnConnect.addEventListener("click", connect);
        }
        if (els.btnDisconnect) {
            els.btnDisconnect.addEventListener("click", disconnect);
        }

        // Search
        if (els.searchForm) {
            els.searchForm.addEventListener("submit", (e) => e.preventDefault());
        }
        if (els.searchSubmit) {
            els.searchSubmit.addEventListener("click", searchAndEnqueue);
        }
        if (els.searchInput) {
            els.searchInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter") { e.preventDefault(); searchAndEnqueue(); }
            });
        }

        // Volume
        let volTimer = null;
        els.volume.addEventListener("input", () => {
            els.volumeLabel.textContent = `${els.volume.value}%`;
            clearTimeout(volTimer);
            volTimer = setTimeout(async () => {
                try { await api("/api/volume", { method: "POST", body: JSON.stringify({ volume: Number(els.volume.value) }) }); }
                catch (e) { toast(e.message, "err"); }
            }, 200);
        });
    }

    // === Boot ===
    (async function init() {
        try {
            const r = await fetch("/api/auth/status", { cache: "no-store" });
            const auth = await r.json();
            if (!auth.authed) { window.location.assign("/login"); return; }
            if (auth.needsSetup) {
                setTimeout(() => toast("Configuration is incomplete. Open Settings to fill it in.", "info"), 300);
            }
        } catch { window.location.assign("/login"); return; }
        initModal();
        wire();
        connectWS();
        pollState();
    })();

    setInterval(pollState, 5000);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") pollState();
    });
})();
