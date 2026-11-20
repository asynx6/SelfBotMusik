"use strict";

/**
 * Minimal process supervisor for the 24/7 voice-sitter.
 *
 * No systemd / pm2 / cron in this container, so the watchdog is a plain Node
 * process: it owns the bot as a child, restarts it on exit, and — importantly —
 * restarts it *before* V8 hits the heap ceiling. An uncontrolled OOM drops the
 * Discord voice session; a controlled recycle + the app's boot auto-rejoin
 * keeps the bot in the channel across restarts.
 *
 * Voice intent lives in SQLite (`voice_stay`), set by the app when the user
 * clicks Connect / Disconnect. The supervisor never decides voice policy.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const LOG = path.join(ROOT, "supervisor.log");
const BOT_LOG = path.join(ROOT, "bot-run.log");
const PID_FILE = path.join(ROOT, "data", "supervisor.pid");

const HEAP_CEILING_MB = Number(process.env.HEAP_CEILING_MB || 512);
// Recycle at ~80% of the ceiling: enough headroom for the graceful shutdown
// to finish before V8 would abort the process.
const RECYCLE_AT_MB = Number(process.env.RECYCLE_AT_MB || Math.floor(HEAP_CEILING_MB * 0.8));
const HEALTH_URL = `http://127.0.0.1:${Number(process.env.WEB_PORT || 3434)}/healthz`;
const CHECK_MS = Number(process.env.SUPERVISOR_CHECK_MS || 15000);
const RESTART_DELAY_MS = Number(process.env.SUPERVISOR_RESTART_MS || 3000);
const UNHEALTHY_LIMIT = 3;

let child = null;
let stopping = false;
let draining = false;
let restarts = 0;
let consecutiveUnhealthy = 0;
let checkTimer = null;

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    process.stdout.write(line);
    try { fs.appendFileSync(LOG, line); } catch {}
}

function activePid() {
    try {
        const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
        if (!Number.isInteger(pid) || pid <= 0) return null;
        process.kill(pid, 0);
        return pid;
    } catch { return null; }
}

function claimPid() {
    const live = activePid();
    if (live && live !== process.pid) {
        log(`Supervisor sudah jalan (pid ${live}). Keluar.`);
        process.exit(1);
    }
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid));
}

function releasePid() {
    try {
        if (Number(fs.readFileSync(PID_FILE, "utf8").trim()) === process.pid) {
            fs.unlinkSync(PID_FILE);
        }
    } catch {}
}

function startBot() {
    const out = fs.openSync(BOT_LOG, "a");
    const proc = spawn(process.execPath, [
        `--max-old-space-size=${HEAP_CEILING_MB}`,
        path.join(ROOT, "index.js"),
    ], {
        cwd: ROOT,
        env: process.env,
        stdio: ["ignore", out, out],
        detached: false,
    });
    child = proc;
    log(`Bot started pid=${proc.pid}`);

    proc.on("exit", (code, signal) => {
        // A newer child may already have replaced this one — ignore stale exits.
        if (child !== proc) return;
        child = null;
        if (stopping) return;
        restarts += 1;
        const why = signal ? `signal ${signal}` : `code ${code}`;
        log(`Bot exited (${why}) — restart #${restarts} in ${RESTART_DELAY_MS}ms`);
        // Must be ref'd: after the child exits there may be no other handle
        // keeping the supervisor alive. An unref'd timer here was the bug
        // that made the watchdog exit instead of restarting the bot.
        setTimeout(() => { if (!stopping) startBot(); }, RESTART_DELAY_MS);
    });
}

function stopBot(reason) {
    if (!child || !child.pid || draining) return;
    draining = true;
    log(`Stopping bot pid=${child.pid}: ${reason}`);
    child.kill("SIGTERM");
    setTimeout(() => {
        if (child && child.pid) {
            log("Bot did not exit on SIGTERM — SIGKILL");
            child.kill("SIGKILL");
        }
    }, 10000).unref();
    // Let the restart delay elapse before another health check can stop it.
    setTimeout(() => { draining = false; }, RESTART_DELAY_MS + 12000).unref();
}

async function checkHealth() {
    if (!child || stopping || draining) return;
    let res;
    try {
        res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const h = await res.json();
        if (h.pid !== child.pid) {
            log(`Health pid mismatch (${h.pid} vs ${child.pid}) — ignoring stale process`);
            return;
        }
        consecutiveUnhealthy = 0;
        const heapMb = Math.round((h.heapUsed || 0) / 1048576);
        const rssMb = Math.round((h.rss || 0) / 1048576);
        if (heapMb >= RECYCLE_AT_MB) {
            log(`Heap ${heapMb}MB >= recycle threshold ${RECYCLE_AT_MB}MB — controlled restart before OOM`);
            stopBot("heap recycle");
            return;
        }
        log(`health ok heap=${heapMb}MB rss=${rssMb}MB voice=${h.voiceConnected ? "in" : "out"} uptime=${h.uptime}s`);
    } catch (e) {
        if (stopping || draining) return;
        consecutiveUnhealthy += 1;
        log(`health check failed (${consecutiveUnhealthy}/${UNHEALTHY_LIMIT}): ${e.message}`);
        if (consecutiveUnhealthy >= UNHEALTHY_LIMIT) {
            consecutiveUnhealthy = 0;
            stopBot("unhealthy");
        }
    }
}

function shutdown() {
    if (stopping) return;
    stopping = true;
    clearInterval(checkTimer);
    log("Supervisor stopping");
    if (child && child.pid) {
        child.kill("SIGTERM");
        setTimeout(() => {
            if (child && child.pid) child.kill("SIGKILL");
            releasePid();
            process.exit(0);
        }, 10000).unref();
    } else {
        releasePid();
        process.exit(0);
    }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

claimPid();
log(`Supervisor pid=${process.pid} heapCeiling=${HEAP_CEILING_MB}MB recycleAt=${RECYCLE_AT_MB}MB`);
startBot();
checkTimer = setInterval(checkHealth, CHECK_MS);
checkTimer.unref();
