// Test-only helper. Resets saved runtime settings so the bot boots in
// "needs-setup" mode again. Keeps users + JWT secret.
const db = require("better-sqlite3")("data/app.sqlite");
const KEYS = [
    "lavalink_host", "lavalink_password", "lavalink_port",
    "lavalink_secure", "guild_id", "channel_id",
];
const stmt = db.prepare("DELETE FROM settings WHERE key IN (" + KEYS.map(() => "?").join(",") + ")");
stmt.run(...KEYS);
console.log("Cleared", KEYS.length, "runtime keys.");
console.log("Remaining settings:");
db.prepare("SELECT key, length(value) AS len FROM settings").all().forEach((r) =>
    console.log("  " + r.key + " [" + r.len + "]")
);
db.close();
