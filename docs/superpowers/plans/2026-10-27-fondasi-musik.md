# Fondasi Musik (Spike + Library + Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mengubah SelfBotMusik dari remote Lavalink menjadi pemutar musik mandiri dengan hybrid storage (Lavalink + disk lokal), antrian tunggal terpadu melalui `PlayerController`, dual-engine (`LavalinkEngine` & `LocalEngine`), download manager (`yt-dlp`), upload handler (`music-metadata`), serta tetap kompatibel penuh dengan dashboard web lama.

**Architecture:** Memisahkan antrian audio dari Poru ke `PlayerController`. Tiap lagu dalam antrian dievaluasi: jika ada file lokal diputar oleh `LocalEngine` (ffmpeg -> Opus -> `@discordjs/voice`), jika online dan Lavalink tersambung diputar oleh `LavalinkEngine` (Poru). Perpindahan engine dilakukan dengan handoff voice bersih dengan penandaan `intentionalDisconnect`. Metadata lagu dan unduhan disimpan di SQLite.

**Tech Stack:** Node.js (CommonJS, `node:test`, `node:assert`), better-sqlite3, `@discordjs/voice`, `opusscript`, `tweetnacl`, `music-metadata`, `busboy`, `yt-dlp` (binary CLI), `ffmpeg` (binary CLI), Express 5.

**Spec:** `2026-10-27-fondasi-musik-design.md`

## Global Constraints

- Kompatibilitas State: Struktur objek `State` (`playing`, `queue`, `paused`, `volume`, `position`, `loop`, dll) tidak boleh diubah atau dihapus agar UI web lama tetap berfungsi 100%. Field tambahan diperbolehkan.
- Hanya satu voice connection per guild pada satu waktu. Engine lama harus di-destroy sebelum engine baru join.
- Semua operasi filesystem file library diisolasi di `data/library/<id>.<ext>` dan cover di `data/covers/<id>.<ext>`.
- Input URL/path tidak boleh diekspos langsung ke command shell; semua child_process spawn menggunakan array arguments tanpa shell (`shell: false`).
- Seluruh endpoint `/api` baru berada di bawah auth cookie JWT yang sudah ada.
- Semua pengujian menggunakan test runner bawaan Node.js (`node:test` dan `node:assert`).

---

### Task 0: Setup Dependencies & Test Runner

**Files:**
- Modify: `package.json`
- Modify: `scripts/audit-pkgs.js`

**Interfaces:**
- Menambahkan dependensi: `@discordjs/voice`, `opusscript`, `tweetnacl`, `music-metadata`, `busboy`.
- Mengubah script `"test"` pada `package.json` menjadi `"node --test"`.

- [ ] **Step 1: Update package.json dengan dependensi baru & test script**

Tambahkan dependensi yang disepakati ke `package.json`:
- `@discordjs/voice`: `^0.18.0`
- `opusscript`: `^0.1.1`
- `tweetnacl`: `^1.0.3`
- `music-metadata`: `^7.14.0` (CommonJS kompatibel)
- `busboy`: `^1.6.0`

Ubah `"test"` script menjadi: `"node --test test/**/*.test.js"`.

- [ ] **Step 2: Jalankan npm install**

Run: `npm install`
Expected: Dependencies terinstall dengan exit code 0.

- [ ] **Step 3: Update scripts/audit-pkgs.js**

Perbarui array `pkgs` di `scripts/audit-pkgs.js` agar mencakup `"music-metadata"` dan `"busboy"`.

- [ ] **Step 4: Jalankan audit package**

Run: `node scripts/audit-pkgs.js`
Expected: Berjalan sukses tanpa syntax error.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json scripts/audit-pkgs.js
git commit -m "chore: add dependencies for local voice, metadata, and uploads"
```

---

### Task 1: Probe Spike Voice Lokal Script

**Files:**
- Create: `scripts/spikes/local-voice.js`

**Interfaces:**
- Skrip mandiri yang dapat dijalankan dengan `node scripts/spikes/local-voice.js [guildId] [channelId] [audioFilePath]`.
- Menggunakan `@discordjs/voice` dan client Discord (`discord.js-selfbot-v13`) untuk menguji kemampuan transmisi audio PCM/Opus via ffmpeg ke voice channel.

- [ ] **Step 1: Buat file probe spike scripts/spikes/local-voice.js**

Implementasikan probe dengan kemampuan:
1. Login menggunakan token Discord (`TOKEN_USER` dari `.env` atau config).
2. Membaca guildId, channelId, dan path file audio.
3. Membuat voice connection dengan `joinVoiceChannel` dari `@discordjs/voice`.
4. Membuat audio player (`createAudioPlayer`) dan audio resource dari stream `ffmpeg` (`createAudioResource(stream)`).
5. Memutar audio dan mencatat event `stateChange`, `error`, dan durasi pemutaran.

- [ ] **Step 2: Verifikasi syntax skrip spike**

Run: `node -c scripts/spikes/local-voice.js`
Expected: Syntax check pass (exit code 0).

- [ ] **Step 3: Commit**

```bash
git add scripts/spikes/local-voice.js
git commit -m "feat(spike): add local voice probe script for VPS testing"
```

---

### Task 2: Model Data SQLite & Migrasi Schema

**Files:**
- Modify: `modules/database.js`
- Create: `test/database-schema.test.js`

**Interfaces:**
- Menambahkan tabel `tracks`, `playlists`, `playlist_tracks`, `likes`, `history`, `downloads` sesuai Bagian 6 spec.
- Menambahkan default settings: `download_concurrency` (3), `max_upload_mb` (200), `library_quota_gb` (10), `ytdlp_path` ('yt-dlp'), `ffmpeg_path` ('ffmpeg').
- Memastikan foreign keys & index aktif.

- [ ] **Step 1: Tulis unit test untuk verifikasi skema database baru**

File: `test/database-schema.test.js`
Menguji bahwa tabel `tracks`, `playlists`, `playlist_tracks`, `likes`, `history`, `downloads` terbentuk sempurna di SQLite in-memory, serta default settings terinisialisasi.

- [ ] **Step 2: Jalankan test database-schema (verifikasi fail sebelum edit)**

Run: `node --test test/database-schema.test.js`
Expected: FAIL (tabel belum didefinisikan).

- [ ] **Step 3: Update modules/database.js dengan schema dan default settings**

Tambahkan `CREATE TABLE IF NOT EXISTS` untuk `tracks`, `playlists`, `playlist_tracks`, `likes`, `history`, `downloads`, serta fungsi inisialisasi default settings jika belum diset.

- [ ] **Step 4: Jalankan test database-schema**

Run: `node --test test/database-schema.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add modules/database.js test/database-schema.test.js
git commit -m "feat(db): add schema for tracks, playlists, downloads and settings defaults"
```

---

### Task 3: Library Service

**Files:**
- Create: `modules/library.js`
- Create: `test/library.test.js`

**Interfaces:**
- `upsertFromLavalink(trackInfo)`: return track row
- `getById(id)`: return track row / null
- `list({ query, filter, limit, offset })`: return `{ tracks: [...], total }`
- `attachFile(id, { filePath, fileSize, format, sha256 })`: update track row
- `removeFile(id)`: unlink file fisik di disk, set `file_path = null`
- `remove(id)`: hapus track jika tidak sedang diputar
- `findBySourceKey(sourceKey)`: return track row / null
- `findBySha256(sha256)`: return track row / null
- `diskUsage()`: return `{ bytes, mb, gb, count }`

- [ ] **Step 1: Tulis unit test untuk library service**

File: `test/library.test.js`
Uji `upsertFromLavalink` dengan deduplikasi `source_key`, `attachFile`, `removeFile`, `list`, `diskUsage`, dan constraint pencarian.

- [ ] **Step 2: Jalankan test library (verifikasi fail)**

Run: `node --test test/library.test.js`
Expected: FAIL (module belum ada).

- [ ] **Step 3: Implementasi modules/library.js**

Buat implementasi `modules/library.js` dengan prepared statements SQLite dan isolasi direktori `data/library/` dan `data/covers/`.

- [ ] **Step 4: Jalankan test library**

Run: `node --test test/library.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add modules/library.js test/library.test.js
git commit -m "feat(library): implement library service for track management and disk stats"
```

---

### Task 4: Download Manager

**Files:**
- Create: `modules/downloads.js`
- Create: `test/downloads.test.js`

**Interfaces:**
- `enqueue(trackIds)`: queue array of trackIds untuk diunduh
- `getStatus(downloadId)` / `list()`: list status unduhan aktif & riwayat
- `cancel(downloadId)`: hentikan proses `yt-dlp` dan bersihkan file `.tmp`
- Event emitter untuk WS progress update.
- Concurrency limiter (sesuai setting `download_concurrency`).
- Quota check terhadap setting `library_quota_gb`.

- [ ] **Step 1: Tulis unit test untuk Download Manager**

File: `test/downloads.test.js`
Uji deduplikasi task download, limit konkurensi (semaphore/queue), handling kegagalan, retry logic, dan pembatalan (cancel).

- [ ] **Step 2: Jalankan test downloads (verifikasi fail)**

Run: `node --test test/downloads.test.js`
Expected: FAIL.

- [ ] **Step 3: Implementasi modules/downloads.js**

Implementasi queue download dengan `child_process.spawn(ytdlpPath, [...args], { shell: false })`, regex parsing output persen progress, penulisan ke `data/library/.tmp/`, pemindahan file akhir ke `data/library/<id>.<ext>`, perhitungan hash sha256, dan integrasi dengan `library.attachFile`.

- [ ] **Step 4: Jalankan test downloads**

Run: `node --test test/downloads.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add modules/downloads.js test/downloads.test.js
git commit -m "feat(downloads): implement yt-dlp download manager with concurrency and progress tracking"
```

---

### Task 5: Upload Handler

**Files:**
- Create: `modules/uploads.js`
- Create: `test/uploads.test.js`

**Interfaces:**
- `handleUpload(req, res)`: Express middleware/handler untuk multipart audio upload.
- Membaca stream menggunakan `busboy`.
- Menghitung sha256 secara streaming.
- Memeriksa batas ukuran `max_upload_mb`.
- Validasi isi audio & ekstraksi ID3 tags (title, artist, album, duration, cover) menggunakan `music-metadata`.
- Dedup by sha256: jika sudah ada, return baris yang ada dengan `{ duplicate: true }`.

- [ ] **Step 1: Tulis unit test untuk Upload Handler**

File: `test/uploads.test.js`
Uji stream hash sha256, deteksi duplikat sha256, ekstraksi metadata, dan penanganan file non-audio.

- [ ] **Step 2: Jalankan test uploads (verifikasi fail)**

Run: `node --test test/uploads.test.js`
Expected: FAIL.

- [ ] **Step 3: Implementasi modules/uploads.js**

Implementasikan upload handler dengan `busboy`, penyimpanan sementara di `data/library/.tmp/`, validasi `music-metadata.parseFile`, penyimpanan cover art ke `data/covers/<id>.<ext>`, dan insert ke tabel `tracks`.

- [ ] **Step 4: Jalankan test uploads**

Run: `node --test test/uploads.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add modules/uploads.js test/uploads.test.js
git commit -m "feat(uploads): implement audio upload handler with metadata parsing and deduplication"
```

---

### Task 6: Engine Abstraction (LavalinkEngine & LocalEngine)

**Files:**
- Create: `modules/engines/base.js`
- Create: `modules/engines/lavalink.js`
- Create: `modules/engines/local.js`
- Create: `test/engines.test.js`

**Interfaces:**
```javascript
class Engine extends EventEmitter {
  name: 'lavalink' | 'local'
  play(trackRow, { volume, startMs }): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
  setVolume(volume): Promise<void>
  getPositionMs(): number
  destroy(): Promise<void>
  // Events: 'end' ({ reason }), 'error' (err), 'stuck'
}
```

- [ ] **Step 1: Tulis unit test untuk Engine Abstraction**

File: `test/engines.test.js`
Uji kontrak interface `Engine`, pemancaran event `end`, `error`, tracking posisi, dan kontrol volume.

- [ ] **Step 2: Jalankan test engines (verifikasi fail)**

Run: `node --test test/engines.test.js`
Expected: FAIL.

- [ ] **Step 3: Implementasi BaseEngine, LavalinkEngine, dan LocalEngine**

- `modules/engines/base.js`: Class dasar turunan `EventEmitter`.
- `modules/engines/lavalink.js`: Membungkus player Poru (memutar 1 track, emit event `end`/`error`/`stuck`).
- `modules/engines/local.js`: Menggunakan `child_process.spawn(ffmpegPath, ...)` decoding ke PCM 48kHz stereo, `@discordjs/voice` `AudioPlayer` + `AudioResource`, dan Discord voice connection.

- [ ] **Step 4: Jalankan test engines**

Run: `node --test test/engines.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add modules/engines/base.js modules/engines/lavalink.js modules/engines/local.js test/engines.test.js
git commit -m "feat(engines): implement BaseEngine, LavalinkEngine and LocalEngine with @discordjs/voice"
```

---

### Task 7: PlayerController & Queue Management

**Files:**
- Create: `modules/player-controller.js`
- Create: `test/player-controller.test.js`

**Interfaces:**
- Mengelola antrian internal: `queue` (array of track objects).
- Status: `currentIndex`, `paused`, `volume`, `loop` (0: OFF, 1: TRACK, 2: QUEUE).
- Operasi:
  - `enqueue(tracks, requester)`: tambah lagu ke antrian.
  - `jumpTo(index)`: loncat ke indeks tertentu.
  - `next()`: lompat ke lagu berikutnya (menghormati mode loop).
  - `stop()`: hentikan pemutaran, kosongkan antrian atau reset posisi.
  - `pause()` / `resume()` / `togglePause()`.
  - `setVolume(vol)`.
  - `setLoop(mode)` / `cycleLoop()`.
  - `removeAt(index)`.
  - `clearQueue()`.
- Aturan pemilihan engine (Bagian 5.1):
  1. Jika track punya `file_path` dan file ada di disk -> `LocalEngine`.
  2. Jika tanpa file dan Lavalink node terhubung -> `LavalinkEngine`.
  3. Selain itu -> skip track dengan notifikasi `lastError` dan audit log.
- Engine Handoff: saat berpindah antara local & lavalink, panggil `destroy()` engine lama, tandai `intentionalDisconnect = true`, lalu inisialisasi voice pada engine baru.
- Menghasilkan snapshot `State` kompatibel dengan format lama.

- [ ] **Step 1: Tulis unit test untuk PlayerController**

File: `test/player-controller.test.js`
Uji `enqueue`, `jumpTo`, `next` dengan berbagai mode loop, engine handoff dengan mock engines, `removeAt`, `clearQueue`, dan kompatibilitas output `snapshot()`.

- [ ] **Step 2: Jalankan test player-controller (verifikasi fail)**

Run: `node --test test/player-controller.test.js`
Expected: FAIL.

- [ ] **Step 3: Implementasi modules/player-controller.js**

Tulis implementasi `PlayerController` lengkap yang mengkoordinasikan engine, antrian, dan state.

- [ ] **Step 4: Jalankan test player-controller**

Run: `node --test test/player-controller.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add modules/player-controller.js test/player-controller.test.js
git commit -m "feat(player): implement unified PlayerController with dual-engine dispatch"
```

---

### Task 8: Integrasi Webserver & API Endpoints Baru

**Files:**
- Modify: `modules/webserver.js`
- Create: `test/webserver-api.test.js`

**Interfaces:**
- Menambahkan route baru:
  - `POST /api/search` -> search via Lavalink, upsert ke `tracks`, kembalikan tracks + flag `downloaded` & `downloading`.
  - `GET /api/library/tracks` -> list library.
  - `POST /api/library/upload` -> upload audio.
  - `DELETE /api/library/tracks/:id/file` -> hapus file fisik lokal.
  - `DELETE /api/library/tracks/:id` -> hapus lagu dari library.
  - `GET /api/library/tracks/:id/cover` -> serve file cover art.
  - `POST /api/downloads` -> enqueue download.
  - `GET /api/downloads` -> list status download.
  - `DELETE /api/downloads/:id` -> cancel download.
  - `POST /api/queue/add` -> body `{ trackIds: [...] }`, enqueue ke PlayerController.
- Memperbarui route yang ada:
  - `/api/play`, `/api/skip`, `/api/stop`, `/api/pause`, `/api/volume`, `/api/loop`, `/api/clear`, `DELETE /api/queue/:idx` diarahkan ke `PlayerController`.

- [ ] **Step 1: Tulis unit test untuk webserver API routes**

File: `test/webserver-api.test.js`
Uji endpoint `/api/search`, `/api/library/tracks`, `/api/downloads`, `/api/queue/add`, dan fallback endpoint lama.

- [ ] **Step 2: Jalankan test webserver-api (verifikasi fail)**

Run: `node --test test/webserver-api.test.js`
Expected: FAIL.

- [ ] **Step 3: Update modules/webserver.js dengan route baru & adapter controller**

Implementasikan route baru dan hubungkan ke service library, downloads, uploads, dan controller.

- [ ] **Step 4: Jalankan test webserver-api**

Run: `node --test test/webserver-api.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add modules/webserver.js test/webserver-api.test.js
git commit -m "feat(api): expose library, download, upload, and queue management endpoints"
```

---

### Task 9: Wiring index.js & Full Integration Test

**Files:**
- Modify: `index.js`
- Create: `test/state-compat.test.js`

**Interfaces:**
- Inisialisasi `PlayerController` di `index.js`.
- Integrasi `wireSafetyEvents` dengan engine voice aktif (menghindari auto-rejoin saat handoff atau saat disconnect sengaja).
- Verifikasi bahwa objek `State` yang dikirim ke WebSocket mempertahankan field: `playing`, `queue`, `paused`, `volume`, `position`, `loop`, `voiceConnected`, `botReady`, `connected`.

- [ ] **Step 1: Tulis test verifikasi kompatibilitas State WebSocket**

File: `test/state-compat.test.js`
Memverifikasi bahwa snapshot yang dipancarkan oleh `PlayerController` dan `stateMod` sesuai dengan ekspektasi frontend legacy.

- [ ] **Step 2: Update index.js**

Hubungkan `PlayerController`, `library`, `downloads`, dan `engine` ke lifecycle aplikasi di `index.js`. Pastikan `leaveVC` dan `joinVC` mendukung delegasi engine.

- [ ] **Step 3: Jalankan seluruh test suite**

Run: `npm test`
Expected: Semua unit test di direktori `test/` PASS.

- [ ] **Step 4: Commit**

```bash
git add index.js test/state-compat.test.js
git commit -m "feat: wire unified PlayerController into main application lifecycle"
```
