# YouTube Downloader Pro

Web-based YouTube downloader with queue support, multiple quality selection, and persistent background processing.

## Highlights

- Modern browser UI with quality buttons and queue dashboard
- Download types: `Video` and `MP3`
- Real quality list from source metadata (up to available `4K/2K/1080p/720p/...`)
- Up to `5` concurrent downloads
- Live progress percentage updates
- Queue persisted in SQLite (`queue.db`)
- Same video ID re-download overwrites the existing output file
- Optional remove behavior: delete queue item only, or queue item + downloaded file

## Requirements

- Node.js 18+ (recommended)
- Internet connection

## Quick Start

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

## How It Works

1. Paste a YouTube URL.
2. Click `Load Options`.
3. Choose a quality button (video) or `Audio MP3`.
4. Item is added to queue and processed server-side.

## Queue Rules

- Duplicate active jobs for same video ID are blocked.
- Browser close hone par bhi downloads continue hote hain (server process running hona chahiye).
- Remove button asks whether to also delete the associated file from disk.

## Output Files

- Download folder: `downloads/`
- Video filename: `<videoId>.<ext>` (usually `.mp4`)
- MP3 filename: `<videoId>.mp3`

## Disclaimer

Use this tool responsibly and follow YouTube Terms of Service and applicable copyright laws.
