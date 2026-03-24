# YouTube Downloader Queue App

Simple browser-based app where you can paste YouTube links, add multiple videos to queue, and download them in highest quality by fetching best video and audio streams separately, then merging with ffmpeg.

## Features

- Browser UI with URL textbox
- Add multiple YouTube links into queue
- Up to 5 concurrent downloads
- Progress updates and final download button
- Select video quality before adding to queue (`360p`, `480p`, `720p HD`, `1080p Full HD`, `4K` etc. based on availability)
- Download mode select: `Video (MP4)`, `Audio (MP3)`
- Pause, resume, and cancel for active downloads
- Persistent queue in SQLite (`queue.db`)
- Duplicate URL is blocked (same video cannot be added repeatedly unless removed)

## Run

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start app:

   ```bash
   npm start
   ```

3. Open in browser:

   ```text
   http://localhost:3000
   ```

## Notes

- Downloads are saved in `downloads/` directory.
- Temporary chunk files are saved in `downloads/temp` and cleaned automatically.
- Queue state survives server restarts using SQLite database `queue.db`.
- Download processing is server-side; browser close karne ke baad bhi downloads continue hote hain (jab tak server process running ho).
