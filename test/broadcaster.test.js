"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { createBroadcaster } = require("../modules/broadcaster");

const OPEN = 1;
const CLOSED = 3;

function fakeClient({ readyState = OPEN, bufferedAmount = 0 } = {}) {
    const client = {
        readyState,
        bufferedAmount,
        isAlive: true,
        sent: [],
        sends: 0,
        terminates: 0,
        pings: 0,
        handlers: {},
        send(payload) {
            this.sends += 1;
            this.sent.push(JSON.parse(payload));
        },
        terminate() {
            this.terminates += 1;
            this.readyState = CLOSED;
            // A real WebSocketServer removes the socket from `clients` on close.
            this.onTerminate?.();
        },
        ping() {
            this.pings += 1;
        },
        on(event, handler) {
            this.handlers[event] = handler;
        },
    };
    return client;
}

function fakeServer(clients = []) {
    const handlers = {};
    return {
        clients: new Set(clients),
        on(event, handler) {
            handlers[event] = handler;
        },
        connect(client) {
            client.onTerminate = () => this.clients.delete(client);
            handlers.connection?.(client);
        },
    };
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test("broadcaster: sends nothing when there are no clients", () => {
    let snapshots = 0;
    const b = createBroadcaster({
        getSnapshot: () => { snapshots += 1; return { playing: null }; },
    });
    b.attach(fakeServer());

    assert.equal(b.pushNow("tick"), 0);
    assert.equal(snapshots, 0, "snapshot must not be built without clients");
});

test("broadcaster: delivers only to open clients", () => {
    const open = fakeClient();
    const closed = fakeClient({ readyState: CLOSED });
    const b = createBroadcaster({ getSnapshot: () => ({ playing: null }) });
    b.attach(fakeServer([open, closed]));

    assert.equal(b.pushNow("tick"), 1);
    assert.equal(open.sends, 1);
    assert.equal(closed.sends, 0);
    assert.equal(open.sent[0].type, "state");
});

test("broadcaster: drops a stalled client instead of buffering forever", () => {
    const stalled = fakeClient({ bufferedAmount: 5 * 1024 * 1024 });
    const healthy = fakeClient();
    const b = createBroadcaster({
        getSnapshot: () => ({ playing: null }),
        maxBufferedBytes: 1024 * 1024,
    });
    b.attach(fakeServer([stalled, healthy]));

    const delivered = b.pushNow("tick");

    assert.equal(delivered, 1, "only the healthy client receives the frame");
    assert.equal(stalled.sends, 0, "a stalled client must not be written to");
    assert.equal(stalled.terminates, 1);
    assert.equal(healthy.sends, 1);
    assert.equal(b.stats().terminated, 1);
});

test("broadcaster: terminates a client whose send throws", () => {
    const broken = fakeClient();
    broken.send = () => { throw new Error("socket closed"); };
    const b = createBroadcaster({ getSnapshot: () => ({}) });
    b.attach(fakeServer([broken]));

    assert.equal(b.pushNow("tick"), 0);
    assert.equal(broken.terminates, 1);
});

test("broadcaster: coalesces a burst into a single serialization", async () => {
    let snapshots = 0;
    const client = fakeClient();
    const b = createBroadcaster({
        getSnapshot: () => { snapshots += 1; return { playing: null }; },
        coalesceMs: 20,
    });
    b.attach(fakeServer([client]));

    for (let i = 0; i < 10; i += 1) b.request("change");
    assert.equal(snapshots, 0, "nothing is sent synchronously");

    await wait(60);

    assert.equal(snapshots, 1, "ten mutations collapse into one snapshot");
    assert.equal(client.sends, 1);
    b.stop();
});

test("broadcaster: a real change is not downgraded to a tick", async () => {
    const client = fakeClient();
    const b = createBroadcaster({ getSnapshot: () => ({}), coalesceMs: 20 });
    b.attach(fakeServer([client]));

    b.request("tick");
    b.request("change");
    await wait(60);

    assert.equal(client.sent.length, 1);
    assert.equal(client.sent[0].tag, "change");
    b.stop();
});

test("broadcaster: heartbeat pings live clients and reaps silent ones", () => {
    const alive = fakeClient();
    const silent = fakeClient();

    const b = createBroadcaster({ getSnapshot: () => ({}), heartbeatMs: 60_000 });
    const server = fakeServer([alive, silent]);
    b.attach(server);
    server.connect(alive);
    server.connect(silent);

    // Sweep 1: both are pinged and marked as awaiting a pong.
    assert.equal(b.sweepHeartbeat(), 0);
    assert.equal(alive.pings, 1);
    assert.equal(silent.pings, 1);
    assert.equal(alive.isAlive, false);

    // The live client answers; the silent one does not.
    alive.handlers.pong();
    assert.equal(alive.isAlive, true);

    // Sweep 2: the answering client survives, the silent one is reaped.
    assert.equal(b.sweepHeartbeat(), 1);
    assert.equal(alive.terminates, 0, "a client that answers the ping survives");
    assert.equal(alive.pings, 2, "the live client keeps receiving pings");
    assert.equal(silent.terminates, 1, "a silent client is reaped exactly once");
    assert.equal(silent.pings, 1, "a silent client is pinged once before being dropped");

    // Sweep 3: the reaped client is gone from the set, so nothing else happens.
    alive.handlers.pong();
    assert.equal(b.sweepHeartbeat(), 0);
    assert.equal(silent.terminates, 1);
    b.stop();
});

test("broadcaster: stop() cancels a pending coalesced push", async () => {
    const client = fakeClient();
    const b = createBroadcaster({ getSnapshot: () => ({}), coalesceMs: 30 });
    b.attach(fakeServer([client]));

    b.request("change");
    b.stop();
    await wait(60);

    assert.equal(client.sends, 0);
    assert.equal(b.stats().pending, false);
});
