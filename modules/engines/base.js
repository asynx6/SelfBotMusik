"use strict";

const { EventEmitter } = require("events");

class BaseEngine extends EventEmitter {
    constructor() {
        super();
        this.name = "base";
    }

    async play(trackRow, options = {}) {
        throw new Error(`play() not implemented on ${this.constructor.name}`);
    }

    async pause() {
        throw new Error(`pause() not implemented on ${this.constructor.name}`);
    }

    async resume() {
        throw new Error(`resume() not implemented on ${this.constructor.name}`);
    }

    async stop() {
        throw new Error(`stop() not implemented on ${this.constructor.name}`);
    }

    async setVolume(volume) {
        throw new Error(`setVolume() not implemented on ${this.constructor.name}`);
    }

    getPositionMs() {
        throw new Error(`getPositionMs() not implemented on ${this.constructor.name}`);
    }

    async destroy() {
        throw new Error(`destroy() not implemented on ${this.constructor.name}`);
    }
}

module.exports = { BaseEngine };
