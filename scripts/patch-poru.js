"use strict";

/**
 * Poru patches required by this bot. Runs from postinstall so `npm install`
 * cannot silently undo them. Idempotent; warns (never crashes) on drift.
 *
 * 1. Rest.js content-type check.
 *    Poru decides between `res.json()` and `res.text()` with an exact string
 *    comparison against "application/json". Real nodes reply with
 *    "application/json; charset=utf-8", so the check fails and the body comes
 *    back as a raw string — every search/resolve then dies with the useless
 *    "Cannot create property 'loadType' on string '<html>…'".
 *
 * 2. Player.js TrackEndEvent for reasons we own.
 *    When WE replace a track (skip / play-now / jump), Lavalink sends
 *    reason="replaced". Poru turns that into `queueEnd` when its own queue is
 *    empty (we clear it on purpose — one owner of the queue). The controller
 *    ignores `replaced` on `trackEnd` but cannot see the reason on `queueEnd`,
 *    so one play-now immediately auto-advanced to the next song. Make Poru
 *    always emit `trackEnd` WITH the reason; the controller already ignores
 *    `replaced` / `cleanup` and advances on `loadFailed` / `finished`.
 */

const fs = require("fs");
const path = require("path");

const REST_TARGET = path.join(__dirname, "..", "node_modules", "poru", "dist", "src", "Node", "Rest.js");
const REST_OLD = 'return req.headers.get("content-type") === "application/json" ? await req.json() : await req.text();';
const REST_NEW = 'return (req.headers.get("content-type") || "").includes("application/json") ? await req.json() : await req.text();';

const PLAYER_TARGET = path.join(__dirname, "..", "node_modules", "poru", "dist", "src", "Player", "Player.js");
const PLAYER_OLD = `                if (["loadFailed", "cleanup", "replaced"].includes(data.reason)) {
                    if (this.queue.length === 0 && this.loop === "NONE") {
                        return this.poru.emit("queueEnd", this);
                    }
                    else {
                        await this.poru.emit("trackEnd", this, this.currentTrack, data);
                        // Cooldown tracking logic for first and second play
                        const now = Date.now();
                        if (!this.lastPlayTimestamp) {
                            this.lastPlayTimestamp = now;
                            setTimeout(async () => {
                                await this.play();
                            }, 3000);
                            return;
                        }
                        const timeSinceLastPlay = now - this.lastPlayTimestamp;
                        if (timeSinceLastPlay <= 5000) {
                            // Add a cooldown of 10 seconds
                            if (!this.cooldown || now - this.cooldown > 10000) {
                                this.cooldown = now;
                                this.lastPlayTimestamp = null; // Reset the timestamp to avoid repeated cooldowns
                                //  this.poru.emit("cooldown", this, 10); // Emit cooldown event (optional)
                                // this.message.delete().catch(e => null)
                                console.log("Cooldown active for 10 seconds due to rapid first and second plays.");
                                return;
                            }
                        }
                        this.lastPlayTimestamp = now; // Update the timestamp for the next play call
                        setTimeout(async () => {
                            await this.play();
                        }, 3000);
                        return;
                    }
                }`;
const PLAYER_NEW = `                if (["loadFailed", "cleanup", "replaced"].includes(data.reason)) {
                    // Keep the reason. Poru's queueEnd here hides it (and its
                    // setTimeout(play) is a second queue scheduler) — one
                    // play-now then auto-advanced to the next song.
                    await this.poru.emit("trackEnd", this, this.currentTrack, data);
                    return;
                }`;

function patch(target, oldText, newText, label, marker) {
    if (!fs.existsSync(target)) {
        console.warn(`[patch-poru] ${label}: poru not installed yet — skipping`);
        return;
    }
    const src = fs.readFileSync(target, "utf8");
    if (src.includes(marker)) return; // already patched
    if (!src.includes(oldText)) {
        console.warn(`[patch-poru] ${label}: pattern changed upstream — verify manually`);
        return;
    }
    fs.writeFileSync(target, src.replace(oldText, newText));
    console.log(`[patch-poru] patched ${label}`);
}

function main() {
    patch(REST_TARGET, REST_OLD, REST_NEW, "content-type check", '.includes("application/json") ? await req.json()');
    patch(PLAYER_TARGET, PLAYER_OLD, PLAYER_NEW, "replaced track-end reason", "// Keep the reason");
}

if (require.main === module) main();

module.exports = {
    main,
    patch,
    REST_TARGET,
    PLAYER_TARGET,
    REST_OLD,
    REST_NEW,
    PLAYER_OLD,
    PLAYER_NEW,
};
