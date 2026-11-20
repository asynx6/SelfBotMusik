"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    patch,
    REST_OLD, REST_NEW,
    PLAYER_OLD, PLAYER_NEW,
} = require("../scripts/patch-poru");

test("patch-poru: content-type check is idempotent", (t) => {
    const file = path.join(t.tempDir || fs.mkdtempSync(path.join(os.tmpdir(), "poru-")), "Rest.js");
    fs.writeFileSync(file, `const ok = ${REST_OLD};`);

    patch(file, REST_OLD, REST_NEW, "test-rest", 'includes("application/json")');
    assert.match(fs.readFileSync(file, "utf8"), /includes\("application\/json"\)/);

    patch(file, REST_OLD, REST_NEW, "test-rest", 'includes("application/json")');
    assert.equal((fs.readFileSync(file, "utf8").match(/includes\("application\/json"\)/g) || []).length, 1);
});

test("patch-poru: replaced track-end keeps its reason (no fabricated queueEnd)", (t) => {
    const dir = t.tempDir || fs.mkdtempSync(path.join(os.tmpdir(), "poru-"));
    const file = path.join(dir, "Player.js");
    const fixture = `class P { async handle(data) {\n${PLAYER_OLD}\nthis.previousTrack = this.currentTrack;\n} }`;
    fs.writeFileSync(file, fixture);

    patch(file, PLAYER_OLD, PLAYER_NEW, "test-player", "// Keep the reason");
    const patched = fs.readFileSync(file, "utf8");
    assert.match(patched, /await this\.poru\.emit\("trackEnd", this, this\.currentTrack, data\)/);
    assert.doesNotMatch(patched, /return this\.poru\.emit\("queueEnd", this\)/);

    // Idempotent: a second run must not duplicate the replacement.
    patch(file, PLAYER_OLD, PLAYER_NEW, "test-player", "// Keep the reason");
    assert.equal((fs.readFileSync(file, "utf8").match(/\/\/ Keep the reason/g) || []).length, 1);
});
