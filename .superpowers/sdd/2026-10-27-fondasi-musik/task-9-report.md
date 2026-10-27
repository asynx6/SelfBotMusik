# Task 9 Report: Wiring index.js & Full Integration

## Status: DONE_WITH_CONCERNS

## Commit
- `67df287` feat: wire unified PlayerController into main application lifecycle (branch `feat/fondasi-musik`)

## Changes

### index.js
1. **PlayerController init** — instantiated at module level with:
   - `createLavalinkEngine: () => new LavalinkEngine({ poru, guildId: Runtime.guildId })`
   - `createLocalEngine: () => new LocalEngine({ client, guildId, channelId, ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg", dataDir: db.DATA_DIR })`
   - `library`, `db: db.db`, `dataDir: db.DATA_DIR`, `getVoiceTarget`, `isLavalinkReady: () => !!stateMod.State.connected`
   - `onIntentionalDisconnect` sets the shared `intentionalDisconnect` flag so engine handoffs suppress safety auto-rejoin.
   - `playerController.on("state")` → `broadcastNow()` so WS clients see controller changes.
   - Init wrapped in try/catch → falls back to legacy player on failure.
2. **ctx extended**: `library`, `downloads`, `uploads`, `playerController`, `searchTracks` (adapts `playerMod.searchTracks(poru, query, requester)`), satisfying `webserver.buildServer` contract.
3. **`syncStateFromPlayer`**: when controller exists, patches `getSnapshot()` into `stateMod.State` (playing/queue/paused/volume/loop/position, all type-coerced); legacy Poru path preserved as fallback.
4. **`tryReconnectVC` engine-aware**: if `currentEngineType === "local"`, rejoin re-runs `LocalEngine._ensureVoiceConnection()` (its own @discordjs/voice connection); Lavalink path unchanged (leaveVC + joinVC via Poru).
5. **`wireSafetyEvents` ctx**: `intentionalDisconnect` getter now also returns true while LocalEngine is active, since LocalEngine manages its own voice connection — a voice-state drop during Local playback is treated as intentional so the Poru-based auto-rejoin doesn't fight the local connection.

### test/state-compat.test.js (new)
- Legacy schema validation of `stateMod.snapshot()` (all 13 fields, correct types, volume 0..200, loop 0..2).
- Controller snapshot → State patch (same path as index.js `syncStateFromPlayer`): playing/queue/pause/volume/loop/stop all keep legacy shape.
- WS bridge simulation via controller `state` events.
- Defensive-copy check (WS clients can't mutate State).
4 tests, all pass.

## Verification
- `node --check index.js` — OK.
- `node --test test/state-compat.test.js` — 4/4 pass.
- `npm test` — 75/75 pass, no regressions.

## Fix Round 1 (commit `a7e81f9`)
- [Important] Removed the `|| playerController.currentEngineType === "local"` override from the `wireSafetyEvents` `intentionalDisconnect` getter — genuine voice drops during Local playback now trigger `tryReconnectVC` again. Handoff marking via `onIntentionalDisconnect` stays.
- Engine-aware branch in `tryReconnectVC` is now reachable: `await eng._ensureVoiceConnection()` (no unhandled rejection); `reconnectAttempts = 0` only after success, so backoff applies to failed Local rejoins.
- Verified: `node --check index.js` OK; state-compat 4/4; `npm test` 75/75.

## Concerns
1. **LocalEngine rejoin heuristic**: the `intentionalDisconnect` getter returning true while LocalEngine is active is a blunt instrument — a genuine (unintentional) drop during Local playback will skip auto-rejoin once. LocalEngine's own connection recovery usually covers it; revisit if drops during local playback are observed in practice.
2. **`getVoiceTarget` is unused by PlayerController internals currently** (kept for interface compatibility per spec).
3. FFMPEG path comes from `process.env.FFMPEG_PATH || "ffmpeg"` — no Settings UI field yet.
