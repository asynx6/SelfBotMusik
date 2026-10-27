# SelfBotMusik — Spec Fondasi (Spike + Library + Engine)

Tanggal: 2026-10-27
Status: DRAFT, menunggu review pemilik project
Cakupan: Tahap 0 (spike) dan Tahap 1 (fondasi) dari peta sub-project di bagian 12.

## 1. Tujuan

Mengubah SelfBotMusik dari "remote control Lavalink" menjadi pemutar musik yang punya
library sendiri, sehingga:

1. Lagu bisa disimpan lokal di disk VPS (lewat download yang dipilih manual atau upload).
2. Lagu lokal tetap bisa diputar ke voice channel Discord walau Lavalink mati.
3. Lagu dari Lavalink dan lagu lokal hidup dalam satu antrian dan satu model data.
4. Data lagu tersimpan rapi, tanpa file ganda, dan siap dipakai playlist, like, history,
   dan rekomendasi di tahap berikutnya.

Tahap ini tidak mengubah tampilan UI. Dashboard lama harus tetap berfungsi selama masa transisi.

## 2. Keputusan yang sudah disepakati (dari brainstorming)

| Topik | Keputusan |
|---|---|
| Tempat audio keluar | Hanya voice channel Discord. Dashboard hanya remote control. |
| Lokasi runtime | Bot dan Lavalink sama-sama di VPS. "Lokal" = disk VPS. |
| Cara lagu masuk library | Download (dipilih manual per lagu, tidak otomatis) dan upload file. |
| Download | Bisa paralel lewat antrian dengan batas jumlah bersamaan. |
| Deteksi duplikat | Sama hanya jika ID sumber persis sama atau hash file persis sama. Tidak ada pencocokan judul/artis. |
| Playlist | Banyak playlist; satu lagu bisa masuk banyak playlist. |
| Lagu Lavalink | Disimpan sebagai referensi (metadata); file baru ada setelah user memilih download. |
| UI (tahap 3) | React + Vite, semua ikon SVG (`lucide-react`), tanpa emoji, tema grey + orange, responsif. |

## 3. Di luar cakupan tahap ini

Playlist (API dan UI), like, riwayat putar (hanya skema tabelnya dibuat), shuffle, reorder
antrian, "play next", pencarian gabungan, UI React, autoplay/rekomendasi, lirik, equalizer.
Semua itu ada di tahap 2 sampai 4 dan masing-masing mendapat spec sendiri.

## 4. Kondisi kode saat ini (hasil membaca repo)

- Poru memegang antrian dan player. `modules/player.js` hanya pembungkus Poru
  (`enqueue`, `skipTrack`, `removeAt`, dll). Antrian tidak bisa lompat, reorder, atau
  dicampur dengan sumber non-Lavalink.
- Join voice dilakukan lewat Poru (`createConnection` + `player.connect`), dan audio dikirim
  oleh Lavalink. Bot sendiri tidak pernah mengirim audio.
- `State` (`modules/state.js`) dibentuk oleh `syncStateFromPlayer()` di `index.js` dan
  dikirim ke dashboard lewat WebSocket. Bentuknya: `playing`, `queue` (lagu aktif di
  indeks 0), `paused`, `volume`, `position`, `loop` (0 OFF, 1 TRACK, 2 QUEUE).
- Safety di `modules/discord.js` (`wireSafetyEvents`) dan `tryReconnectVC` di `index.js`
  auto-rejoin saat voice terputus, dengan flag `intentionalDisconnect` untuk memutus
  rejoin saat disconnect disengaja.
- Persistensi: SQLite lewat `modules/database.js` (skema dibuat di `db.exec` saat boot,
  helper `getSetting`/`setSetting`/`audit`).
- Semua route `/api` dilindungi middleware auth di `modules/webserver.js`.

## 5. Arsitektur

```
Dashboard (UI lama, nanti React)
        |  REST + WebSocket (port yang sama)
        v
   webserver.js  --->  library service  <--->  SQLite (tracks, playlists, ...)
        |                    ^   ^
        v                    |   |
   PlayerController          |   +--- download manager (yt-dlp, antrian paralel)
   (memegang antrian)        |   +--- upload handler (stream + sha256 + tag)
        |
        +--- LavalinkEngine (membungkus Poru)
        +--- LocalEngine    (file -> ffmpeg -> Opus -> voice Discord)
```

### 5.1 PlayerController

- Memegang antrian sendiri (array item, bukan antrian Poru), indeks lagu aktif, mode loop,
  volume, dan status pause.
- Operasi inti tahap ini: `enqueue(trackIds)`, `jumpTo(index)`, `next()`, `stop()`,
  `pause()/resume()`, `setVolume()`, `setLoop()`, `remove(index)`, `clear()`.
  (`jumpTo` ada di controller, endpoint publiknya baru di tahap 2.)
- Reorder, shuffle, dan "play next" ditunda ke tahap 2, tetapi struktur antrian harus
  mengizinkannya tanpa mengubah antarmuka engine.
- Memilih engine untuk tiap lagu dengan aturan:
  1. Lagu punya `file_path` yang file-nya ada di disk: `LocalEngine`.
  2. Lagu tanpa file dan Lavalink node terhubung: `LavalinkEngine`.
  3. Selain itu: lagu dilewati dengan notifikasi di state (`lastError`) dan audit log.
- Mengisi ulang `State` (`playing`, `queue`, `paused`, `loop`, `position`) dengan bentuk
  yang sama seperti sekarang, supaya UI lama tidak rusak. Field tambahan boleh ditambah,
  field lama tidak boleh dihapus atau diubah artinya.
- Menangani loop sendiri (OFF, TRACK, QUEUE), bukan lagi lewat `player.setLoop` Poru.
- Mencatat `play_count` dan `last_played_at` saat lagu mulai diputar.

### 5.2 Engine (antarmuka)

```
Engine {
  name                      // 'lavalink' | 'local'
  play(trackRow, { volume, startMs }) -> Promise<void>
  pause() / resume()
  stop()
  setVolume(0..200)
  getPositionMs()
  destroy()                 // lepas koneksi voice milik engine ini
  events: 'end' ({reason}), 'error' (err), 'stuck'
}
```

- `LavalinkEngine`: memakai Poru yang sudah ada. Tidak lagi memakai `player.queue`
  Poru untuk antrian; hanya memutar satu track pada satu waktu dan melaporkan `end`.
- `LocalEngine`: membuka file dengan ffmpeg (decode, normalisasi ke 48 kHz stereo,
  volume lewat filter), lalu mengirim Opus lewat koneksi voice milik engine ini.
  Tahap ini selalu decode lewat ffmpeg. Passthrough Opus tanpa re-encode adalah
  optimasi yang tidak dikerjakan di tahap ini.

### 5.3 Kepemilikan koneksi voice (poin risiko utama)

Hanya satu pemilik voice per guild pada satu waktu: Poru/Lavalink atau `LocalEngine`.
Keduanya tidak bisa menyala bersamaan di guild yang sama.

- Saat lagu berikutnya memakai engine yang berbeda dari lagu sebelumnya, controller
  melakukan handoff: engine lama `destroy()`, engine baru join voice channel yang sama.
  Akan ada jeda singkat (target di bawah 3 detik, diukur di spike).
- Handoff yang disengaja harus menandai `intentionalDisconnect` supaya `wireSafetyEvents`
  dan `tryReconnectVC` tidak menganggapnya sebagai putus koneksi.
- `tryReconnectVC` dan `joinVC` harus sadar-engine: rejoin dilakukan oleh engine yang
  sedang aktif, bukan selalu Poru.
- Alternatif yang ditimbang dan belum dipilih: bot menyajikan file lokal lewat HTTP
  internal (`127.0.0.1`) dan Lavalink memutarnya, sehingga hanya ada satu jalur voice dan
  tidak ada handoff. Alternatif ini tidak memenuhi syarat "lagu lokal jalan tanpa
  Lavalink", sehingga hanya menjadi cadangan jika spike gagal (lihat bagian 10).

## 6. Model data (SQLite, ditambahkan ke `modules/database.js`)

```sql
CREATE TABLE IF NOT EXISTS tracks (
    id             INTEGER PRIMARY KEY,
    source_key     TEXT UNIQUE NOT NULL,   -- 'youtube:<id>' | '<sourceName>:<identifier>' | 'sha256:<hash>'
    source_type    TEXT NOT NULL,          -- 'lavalink' | 'upload'
    source_name    TEXT,                   -- youtube, soundcloud, ...
    identifier     TEXT,
    title          TEXT NOT NULL,
    artist         TEXT,
    album          TEXT,
    duration_ms    INTEGER,
    uri            TEXT,
    file_path      TEXT,                   -- relatif terhadap data/library/, NULL jika belum lokal
    file_size      INTEGER,
    format         TEXT,
    sha256         TEXT,
    cover_path     TEXT,                   -- relatif terhadap data/covers/
    cover_url      TEXT,
    created_at     INTEGER NOT NULL,
    downloaded_at  INTEGER,
    play_count     INTEGER NOT NULL DEFAULT 0,
    last_played_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tracks_sha256 ON tracks(sha256);
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);

CREATE TABLE IF NOT EXISTS playlists (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id    INTEGER NOT NULL REFERENCES tracks(id)    ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    added_at    INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, track_id)    -- satu lagu satu kali per playlist
);
CREATE TABLE IF NOT EXISTS likes (
    track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    liked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
    id        INTEGER PRIMARY KEY,
    track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    played_at INTEGER NOT NULL,
    ms_played INTEGER
);
CREATE TABLE IF NOT EXISTS downloads (
    id          INTEGER PRIMARY KEY,
    track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    status      TEXT NOT NULL,             -- queued | running | done | failed | canceled
    progress    REAL NOT NULL DEFAULT 0,   -- 0..1
    error       TEXT,
    created_at  INTEGER NOT NULL,
    started_at  INTEGER,
    finished_at INTEGER
);
```

Aturan data:

- Lagu "referensi" dan lagu "sudah lokal" adalah baris yang sama. Download hanya mengisi
  `file_path`, `file_size`, `format`, `sha256`, `downloaded_at`. Tidak ada baris ganda.
- `source_key` untuk lagu Lavalink dibentuk dari `info.sourceName` + `info.identifier`
  yang dikembalikan Lavalink. Untuk upload: `sha256:<hash isi file>`.
- Tabel `playlists`, `playlist_tracks`, `likes`, `history` dibuat sekarang, tetapi belum
  punya API atau UI di tahap ini.
- Migrasi memakai `CREATE TABLE IF NOT EXISTS`, sama seperti pola `database.js` sekarang.
  Tidak ada perubahan pada tabel yang sudah ada.

Penyimpanan file:

- `data/library/<id>.<ext>` untuk audio, `data/covers/<id>.<ext>` untuk cover.
- Nama file selalu dibentuk dari `id` baris, tidak pernah dari input user.
- `data/` sudah ada di `.gitignore`.

## 7. Komponen

### 7.1 Library service (`modules/library.js`)

Satu pintu ke tabel `tracks`: `upsertFromLavalink(info)`, `getById`, `list({query,limit,offset})`,
`attachFile(id, fileInfo)`, `removeFile(id)`, `remove(id)`, `findBySourceKey`, `findBySha256`,
`diskUsage()`. Semua query memakai prepared statement.

### 7.2 Pencarian (menggantikan sebagian `player.searchTracks`)

`POST /api/search { query }` memanggil Lavalink, meng-upsert setiap hasil ke `tracks`
(jika `source_key` sudah ada, dipakai ulang), dan mengembalikan daftar lagu beserta `id`,
`downloaded` (boolean), dan `downloading` (boolean). Ini yang memungkinkan user memilih lagu
mana yang di-download.

### 7.3 Download manager (`modules/downloads.js`)

- Antrian dengan batas paralel `download_concurrency` (default 3, bisa diubah di Settings).
- Input hanya `trackId`. Tidak pernah menerima URL bebas dari klien. URL diambil dari
  `tracks.uri` yang sebelumnya berasal dari Lavalink. Input URL dari user tetap lewat
  `/api/play` atau `/api/search` yang di-resolve Lavalink lebih dulu menjadi baris `tracks`.
- Sebelum mulai: jika lagu sudah punya `file_path` yang file-nya ada, status langsung `done`
  tanpa mengunduh (cegah dobel). Jika ada download aktif untuk lagu yang sama, dipakai ulang.
- Menjalankan `yt-dlp` lewat `child_process.spawn` dengan argumen berupa array (tanpa shell),
  ke file sementara di `data/library/.tmp/`, lalu dipindah ke nama akhir setelah selesai dan
  setelah hash dihitung.
- Format: audio terbaik apa adanya (tanpa konversi paksa) untuk menghindari re-encode.
- Progres dibaca dari output `yt-dlp` dan dikirim lewat `stateMod.emitter` ke WebSocket.
- Gagal: coba ulang sekali, lalu `failed` dengan pesan error ringkas. Cancel mengirim
  SIGTERM ke proses dan menghapus file sementara.
- Menolak memulai download jika `diskUsage()` sudah mencapai `library_quota_gb`.

### 7.4 Upload (`modules/uploads.js`)

- `POST /api/library/upload` multipart (satu atau banyak file).
- Streaming ke file sementara sambil menghitung sha256; batas `max_upload_mb` per file.
- Validasi dengan `music-metadata` (file harus bisa di-parse sebagai audio), bukan hanya
  dari ekstensi atau MIME dari klien.
- Jika `sha256` sudah ada di `tracks.sha256` (termasuk file hasil download), tidak dibuat
  baris baru dan file sementara dihapus. API mengembalikan baris yang sudah ada dengan
  `duplicate: true`.
- Tag (judul, artis, album, durasi) dan cover tertanam dibaca dengan `music-metadata`.
  Jika tag kosong, judul dari nama file (dibersihkan), artis `Unknown`.

### 7.5 Tag dan cover (fitur V1 nomor 8)

- Upload: dari tag tertanam. Download: dari info `yt-dlp` (judul, uploader, thumbnail).
- Cover disimpan ke `data/covers/<id>.<ext>`, dilayani lewat
  `GET /api/library/tracks/:id/cover` di balik auth. Folder tidak pernah diekspos statis.

## 8. API tahap ini

Semua di bawah middleware auth `/api` yang sudah ada.

| Method | Path | Fungsi |
|---|---|---|
| POST | `/api/search` | Cari lewat Lavalink, upsert hasil, kembalikan lagu + status lokal |
| GET | `/api/library/tracks` | Daftar lagu (query, limit, offset, filter lokal/semua) |
| POST | `/api/library/upload` | Upload file audio |
| DELETE | `/api/library/tracks/:id/file` | Hapus file lokal, pertahankan referensi |
| DELETE | `/api/library/tracks/:id` | Hapus lagu sepenuhnya (ditolak jika sedang diputar) |
| GET | `/api/library/tracks/:id/cover` | Cover lagu |
| POST | `/api/downloads` | Body `{ trackIds: [...] }`, masukkan ke antrian download |
| GET | `/api/downloads` | Status semua download |
| DELETE | `/api/downloads/:id` | Batalkan download |
| POST | `/api/queue/add` | Body `{ trackIds: [...] }`, tambahkan lagu (lokal atau Lavalink) ke antrian |

Endpoint lama (`/api/play`, `/skip`, `/stop`, `/pause`, `/volume`, `/loop`, `/clear`,
`DELETE /api/queue/:idx`, `/settings`, `/connect`, `/disconnect`) tetap ada dengan perilaku
yang sama dari sisi klien, tetapi diimplementasikan di atas `PlayerController`.
`/api/play { query }` sekarang: resolve lewat Lavalink, upsert ke `tracks`, lalu enqueue.

Pengaturan baru (tabel `settings`): `download_concurrency` (3), `max_upload_mb` (200),
`library_quota_gb` (10), `ytdlp_path` (default `yt-dlp`), `ffmpeg_path` (default `ffmpeg`).

## 9. Alur data

1. User mencari lagu: `POST /api/search` -> Lavalink -> upsert `tracks` -> daftar kembali ke UI.
2. User memilih lagu untuk di-download: `POST /api/downloads` -> download manager ->
   `yt-dlp` -> file + hash -> `attachFile` -> progres via WebSocket.
3. User memutar lagu: `POST /api/queue/add` -> controller menaruh di antrian -> saat giliran,
   controller memilih engine (aturan 5.1) -> engine memutar ke voice -> state dipublikasikan.
4. Lavalink mati: lagu dengan `file_path` tetap diputar `LocalEngine`; lagu referensi
   dilewati dengan notifikasi.

## 10. Spike (Tahap 0, dikerjakan sebelum fondasi)

Pertanyaan: apakah `discord.js-selfbot-v13` bisa mengirim audio dari file lokal ke voice
channel secara stabil, dan apakah handoff antara Lavalink dan lokal berjalan bersih?

Probe: skrip terpisah `scripts/spikes/local-voice.js` (dibuang setelah spike). Memutar satu
file ke voice channel tes lewat `@discordjs/voice` + ffmpeg. Dijalankan oleh pemilik project
di VPS (tidak bisa dijalankan dari lingkungan pengembangan karena butuh akun Discord asli).

Kriteria lulus:

1. Join voice channel dan audio terdengar jelas.
2. Memutar terus selama 30 menit tanpa putus, tanpa desync atau suara patah.
3. Handoff Lavalink -> lokal -> Lavalink di guild yang sama berhasil dengan jeda di bawah
   3 detik dan tanpa state voice yang menggantung.
4. Setelah koneksi voice sengaja diputus, rejoin berhasil dan audio berlanjut.

Jika gagal, pilihan yang diambil pemilik project: (a) cari library voice lain, atau
(b) turunkan syarat menjadi "lagu lokal diputar lewat Lavalink via HTTP internal" dan
syarat "tanpa Lavalink" dibatalkan. Spec ini direvisi sebelum plan fondasi dikerjakan.

## 11. Penanganan error, keamanan, pengujian

Error:

- Download gagal: retry sekali, lalu `failed` dengan pesan. Tidak memblokir download lain.
- ffmpeg berhenti di tengah lagu: controller lompat ke lagu berikutnya, catat di audit log.
- File lokal hilang dari disk: lagu dianggap tidak lokal (`file_path` dikosongkan) dan
  dicoba lewat Lavalink jika tersedia.
- Disk melewati kuota atau penuh: download dan upload ditolak sebelum menulis.
- Lavalink mati: lihat alur nomor 4 di bagian 9.

Keamanan:

- Klien hanya mengirim ID lagu, tidak pernah path file atau URL ke `yt-dlp`.
- Nama file di disk dibentuk dari `id`, bukan input user; cek path traversal tetap dilakukan.
- Argumen `yt-dlp` dan `ffmpeg` selalu array, tidak lewat shell.
- Upload: batas ukuran, validasi isi file (bukan hanya ekstensi), hash streaming.
- Semua endpoint baru di balik auth; cover dan audio tidak diekspos sebagai folder statis.

Pengujian (`node:test`):

- Pembentukan dan unik-nya `source_key`; dedup upload via sha256.
- `PlayerController`: enqueue, jumpTo, next, remove, clear, loop (OFF/TRACK/QUEUE),
  pemilihan engine (lokal/Lavalink/dilewati) dengan engine palsu.
- Download manager: batas paralel, cegah dobel, retry, cancel, dengan `spawn` palsu.
- Library service dengan SQLite in-memory.
- Kompatibilitas: bentuk `State` (`playing`, `queue`, `paused`, `loop`, `position`) tidak berubah.
- `LocalEngine` dan handoff voice diuji manual di VPS (lihat spike).

## 12. Peta sub-project (urutan disepakati)

0. Spike voice lokal (bagian 10)
1. Fondasi: dokumen ini
2. Playlist + kontrol player: banyak playlist, play dari list, play next / add to queue,
   drag reorder, shuffle/repeat, Liked Songs, riwayat putar
3. UI baru: React + Vite di `web/`, di-build lalu disajikan Express; ikon `lucide-react`,
   tanpa emoji; grey + orange; responsif; pencarian gabungan lokal + online
4. Autoplay/rekomendasi: kandidat dari library + riwayat, Last.fm, dan pencarian YouTube
   lewat Lavalink, dengan skor kecocokan dan ketersediaan; lokal mendapat bonus skor

## 13. Dependensi baru

- npm: `@discordjs/voice`, library Opus (`opusscript` atau `@discordjs/opus`),
  library enkripsi voice (`sodium-native` atau `tweetnacl`), `music-metadata`,
  library multipart (`busboy` atau `multer`).
- Binary di VPS: `ffmpeg`, `yt-dlp`.
- Versi pasti dipilih di plan setelah spike. `scripts/audit-pkgs.js` perlu diperbarui
  agar daftar paketnya sesuai.

## 14. Risiko dan hal terbuka

- Dukungan voice di `discord.js-selfbot-v13` belum terbukti stabil (dijawab spike).
- Handoff engine menimbulkan jeda di batas lagu lokal/Lavalink; ukuran jeda diukur di spike.
- Download dari YouTube melanggar ToS YouTube, di luar risiko ToS selfbot yang sudah ada.
  Keputusan ada di pemilik project dan sudah diketahui.
- `yt-dlp` sering perlu diperbarui karena perubahan situs; perlu cara mudah memperbarui
  binary di VPS (dicatat di README, bukan fitur otomatis).
- Kuota disk default 10 GB dan batas upload 200 MB adalah angka awal, bisa diubah di Settings.
