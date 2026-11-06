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
    // Playback-level failure from the PlayerController (e.g. a track that
    // could not be played). Kept separate from `lastError`, which carries
    // Discord/Lavalink/runtime system errors.
    playbackError: null,
    loop: 0, // 0 OFF, 1 TRACK, 2 QUEUE
    needsSetup: true,
};

const emitter = new EventEmitter();
// A finite limit keeps Node's "possible EventEmitter memory leak" warning
// working. Setting 0 (unlimited) silently hides listener accumulation.
emitter.setMaxListeners(20);

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
    // Shallow copy is enough: every value written into State is a plain,
    // already-serialized object (see serializeTrack), and consumers only
    // stringify. The previous JSON.parse(JSON.stringify()) round-trip
    // serialized the whole queue twice per push, twice a second.
    return {
        ...State,
        queue: Array.isArray(State.queue) ? State.queue.slice() : [],
    };
}

module.exports = {
    State,
    patch,
    tick,
    snapshot,
    emitter,
};
