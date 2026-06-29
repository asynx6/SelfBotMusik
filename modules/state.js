"use strict";

const EventEmitter = require("events");

const State = {
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
    loop: 0, // 0 OFF, 1 TRACK, 2 QUEUE
    needsSetup: true,
};

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

function patch(partial) {
    Object.assign(State, partial);
    emitter.emit("change", State);
}

// The 500 ms position ticker: only update if changed since last tick.
function tick(getPlayer) {
    const p = getPlayer?.();
    if (!p) return;
    const next = p.position || 0;
    if (Math.abs(State.position - next) < 250) return; // suppress duplicate ticks
    State.position = next;
    emitter.emit("tick", State);
}

function snapshot() {
    // Always return a safe copy so WS clients can't mutate the live state.
    return JSON.parse(JSON.stringify(State));
}

module.exports = {
    State,
    patch,
    tick,
    snapshot,
    emitter,
};
