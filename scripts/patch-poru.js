"use strict";

/**
 * Patch Poru's REST content-type check.
 *
 * Poru decides between `res.json()` and `res.text()` with an exact string
 * comparison:
 *
 *   req.headers.get("content-type") === "application/json"
 *
 * Real Lavalink nodes reply `application/json; charset=utf-8`, so the check
 * fails, the body comes back as a raw string, and `new Response(string)` blows
 * up with the useless
 *
 *   Cannot create property 'loadType' on string '<html>…'
 *
 * (or, for a valid JSON body, silently loses every track). Every node that sets
 * a charset — essentially all of them — is affected.
 *
 * Runs from postinstall so `npm install` cannot silently undo it. Idempotent.
 */

const fs = require("fs");
const path = require("path");

const TARGET = path.join(__dirname, "..", "node_modules", "poru", "dist", "src", "Node", "Rest.js");
const OLD = 'return req.headers.get("content-type") === "application/json" ? await req.json() : await req.text();';
const NEW = 'return (req.headers.get("content-type") || "").includes("application/json") ? await req.json() : await req.text();';

function main() {
    if (!fs.existsSync(TARGET)) {
        // Not a hard failure: `npm install --omit=optional` or a pre-install run
        // can legitimately have no poru yet. postinstall runs before this check
        // in a normal install, so silence would hide a real breakage.
        console.warn("[patch-poru] poru not installed yet — skipping");
        return;
    }

    const src = fs.readFileSync(TARGET, "utf8");

    if (src.includes(NEW)) {
        return; // already patched
    }

    if (!src.includes(OLD)) {
        console.warn("[patch-poru] pattern changed upstream — verify Rest.js manually");
        return;
    }

    fs.writeFileSync(TARGET, src.replace(OLD, NEW));
    console.log("[patch-poru] patched Poru content-type check");
}

main();
