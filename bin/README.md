# bin/ — bundled external binaries

This folder holds the platform-specific binaries the app shells out to:

| File | Used by | Purpose |
|---|---|---|
| `ffmpeg` / `ffmpeg.exe` | `modules/engines/local.js` | decode audio to raw PCM 48 kHz stereo |
| `yt-dlp` / `yt-dlp.exe` | `modules/downloads.js` | fetch audio for tracks the user chose to download |

They are **not** committed to git. Fetch them once per machine/container:

```bash
npm run setup:bin          # download whatever is missing
npm run update:bin         # force re-download (use this to update yt-dlp)
```

`npm install` also runs the fetch automatically (skippable with
`SKIP_BINARY_FETCH=1`), so a fresh Pterodactyl deploy is self-contained.

Resolution order at runtime (see `modules/binaries.js`):

1. `FFMPEG_PATH` / `YTDLP_PATH` environment variable
2. this folder
3. `settings.ffmpeg_path` / `settings.ytdlp_path` in SQLite
4. bare command name, looked up on `PATH`

Because this folder takes priority over the settings table, a database copied
from another machine can never point the container at a stale absolute path.

## Windows vs Linux

The binaries are platform-specific and `bin/*` is git-ignored, so they never
travel between machines through git. If you develop on Windows and upload the
folder to a Linux container, `npm run setup:bin` removes the now-useless
`.exe` files and fetches the Linux builds (`--no-prune` keeps them).

On Linux the resolver only looks for `bin/ffmpeg`, never `bin/ffmpeg.exe`, so
a leftover Windows binary is ignored rather than executed.
