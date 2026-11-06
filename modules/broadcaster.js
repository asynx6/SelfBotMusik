"use strict";

/**
 * Dashboard state broadcaster.
 *
 * Owns everything that used to be inline in `webserver.js`: payload
 * serialization, burst coalescing, backpressure handling, and the liveness
 * heartbeat. Extracted so it can be unit-tested without HTTP.
 *
 * Three failure modes it guards against, all of which cause RSS to climb
 * forever on a long-running instance:
 *
 *   1. Dead peers. Without a ping/pong the server keeps a half-open socket in
 *      `wss.clients` forever and keeps writing to it (browser tab closed,
 *      laptop suspended, NAT rebinding).
 *   2. Backpressure. `ws` does not apply flow control: once the peer stops
 *      reading, `send()` queues the payload in native memory, invisible to the
 *      JS heap. `heapUsed` looks healthy while RSS explodes.
 *   3. Bursts. Every state mutation used to trigger a full snapshot; a
 *      coalescing window collapses them into one serialization.
 */

const DEFAULT_COALESCE_MS = 150;
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024; // 1 MB queued per client is already pathological
const DEFAULT_HEARTBEAT_MS = 30_000;
const OPEN = 1;

function createBroadcaster({
    getSnapshot,
    maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES,
    coalesceMs = DEFAULT_COALESCE_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    log = console,
} = {}) {
    if (typeof getSnapshot !== "function") {
        throw new TypeError("createBroadcaster: getSnapshot must be a function");
    }

    let wss = null;
    let pendingTimer = null;
    let pendingTag = null;
    let heartbeatTimer = null;
    let terminated = 0;

    function send(tag) {
        if (!wss || wss.clients.size === 0) return 0;

        const payload = JSON.stringify({ type: "state", tag, data: getSnapshot() });
        let delivered = 0;

        for (const client of wss.clients) {
            if (client.readyState !== OPEN) continue;

            // A stalled peer never drains. Cut it loose instead of buffering.
            if (client.bufferedAmount > maxBufferedBytes) {
                terminated += 1;
                try { client.terminate(); } catch { /* already gone */ }
                continue;
            }

            try {
                client.send(payload);
                delivered += 1;
            } catch {
                terminated += 1;
                try { client.terminate(); } catch { /* already gone */ }
            }
        }
        return delivered;
    }

    /**
     * Queue a push. Consecutive calls inside `coalesceMs` collapse into one
     * serialization; `change` outranks `tick` so a real update is never
     * downgraded to a position-only frame.
     */
    function request(tag = "change") {
        if (pendingTag !== "change") pendingTag = tag;
        if (pendingTimer) return false;
        pendingTimer = setTimeout(() => {
            pendingTimer = null;
            const tagToSend = pendingTag || "update";
            pendingTag = null;
            send(tagToSend);
        }, coalesceMs);
        return true;
    }

    function pushNow(tag = "update") {
        return send(tag);
    }

    /**
     * One heartbeat sweep: ping every live client, terminate every client that
     * failed to answer the previous ping. Exposed separately from the interval
     * so it can be driven deterministically in tests.
     */
    function sweepHeartbeat() {
        if (!wss) return 0;
        let reaped = 0;
        for (const client of wss.clients) {
            if (client.isAlive === false) {
                terminated += 1;
                reaped += 1;
                try { client.terminate(); } catch { /* already gone */ }
                continue;
            }
            client.isAlive = false;
            try { client.ping(); } catch { /* socket already closed */ }
        }
        return reaped;
    }

    /**
     * Take ownership of a WebSocketServer: installs per-connection liveness
     * tracking and the periodic heartbeat sweep.
     */
    function attach(server) {
        wss = server;

        server.on("connection", (client) => {
            client.isAlive = true;
            if (typeof client.on === "function") {
                client.on("pong", () => { client.isAlive = true; });
                client.on("error", () => {
                    try { client.terminate(); } catch { /* already gone */ }
                });
            }
        });

        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(sweepHeartbeat, heartbeatMs);
        // Never hold the event loop open just for the heartbeat.
        if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();

        return wss;
    }

    function stop() {
        if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
        }
        pendingTag = null;
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
    }

    function stats() {
        return {
            clients: wss ? wss.clients.size : 0,
            terminated,
            pending: Boolean(pendingTimer),
        };
    }

    return { attach, request, pushNow, send, stop, stats, sweepHeartbeat };
}

module.exports = {
    createBroadcaster,
    DEFAULT_COALESCE_MS,
    DEFAULT_MAX_BUFFERED_BYTES,
    DEFAULT_HEARTBEAT_MS,
};
