"use strict";
const fs = require("fs");
const path = require("path");

const root = process.cwd();
const pkgs = [
    "@discordjs/voice", "@distube/ytdl-core",
    "bcryptjs", "better-sqlite3", "cookie-parser",
    "discord-ytdl-core", "discord.js-selfbot-v13",
    "dotenv", "express", "ffmpeg-static", "jsonwebtoken",
    "node-fetch", "opusscript", "poru", "shoukaku",
    "sodium-native", "tweetnacl", "ws"
];

const dirs = ["index.js", "modules", "public", "scripts"];
const files = [];
function walk(d) {
    const full = path.join(root, d);
    if (!fs.existsSync(full)) return;
    const st = fs.statSync(full);
    if (st.isFile() && d.endsWith(".js")) files.push(full);
    if (st.isDirectory()) {
        for (const e of fs.readdirSync(full)) {
            if (e === "node_modules") continue;
            const sub = path.join(d, e);
            if (fs.statSync(path.join(root, sub)).isDirectory()) walk(sub);
            else if (sub.endsWith(".js")) files.push(path.join(root, sub));
        }
    }
}
for (const d of dirs) walk(d);

const usage = {};
for (const p of pkgs) {
    usage[p] = { usedIn: [], lines: [] };
    const re = new RegExp(`require\\s*\\(\\s*['"\`]${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"\`]\\s*\\)|from\\s+['"\`]${p}\\s*['"\`]`);
    for (const f of files) {
        const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
        for (const [i, line] of lines.entries()) {
            if (re.test(line)) {
                usage[p].usedIn.push(path.relative(root, f) + ":" + (i + 1));
                usage[p].lines.push(line.trim());
            }
        }
    }
}

console.log("\n=== Package Usage Audit ===\n");
let usedCount = 0, unusedCount = 0;
for (const p of pkgs) {
    const u = usage[p];
    if (u.usedIn.length > 0) {
        usedCount++;
        console.log(`[USED  ] ${p}`);
        for (let i = 0; i < u.usedIn.length && i < 3; i++) {
            console.log(`         ${u.usedIn[i]}  →  ${u.lines[i].substring(0,80)}`);
        }
    } else {
        unusedCount++;
        console.log(`[UNUSED] ${p}`);
    }
}
console.log(`\nResult: ${usedCount} used, ${unusedCount} unused (of ${pkgs.length})`);
