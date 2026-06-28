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
    emitter.emit("changed", State);
}

function defineResetPath(getPlayer, syncFromPlayer) {
    // The 500 ms position ticker refreshes time without going through Poru again.
    return function refreshPosition() {
        const p = getPlayer();
        if (!p) return;
        State.position = p.position || 0;
    };
}

function snapshot() {
    // Always return a safe copy so WS clients can't mutate the live state.
    return JSON.parse(JSON.stringify(State));
}

module.exports = {
    State,
    patch,
    snapshot,
    emitter,
    defineResetPath,
};
