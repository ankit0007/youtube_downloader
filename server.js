const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const sqlite3 = require("sqlite3").verbose();
const ytdl = require("@distube/ytdl-core");
const ffmpegPath = require("ffmpeg-static");
const ytDlp = require("yt-dlp-exec");

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_CONCURRENT_DOWNLOADS = 5;

const downloadsDir = path.join(__dirname, "downloads");
const tempDir = path.join(downloadsDir, "temp");
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

const db = new sqlite3.Database(path.join(__dirname, "queue.db"));

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/downloads", express.static(downloadsDir));

let queue = [];
const activeTasks = new Map();

function runDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      return resolve(this);
    });
  });
}

function allDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      return resolve(rows);
    });
  });
}

function sanitizeFileName(input) {
  return input.replace(/[<>:"/\\|?*]+/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function isNonRemovableStatus(status) {
  return ["queued", "downloading", "merging", "paused"].includes(status);
}

function parseQualityPreference(preference) {
  if (!preference || preference === "best") return null;
  const parsed = Number(preference);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function normalizeDownloadType(value) {
  const type = String(value || "video").toLowerCase();
  if (["video", "mp3"].includes(type)) return type;
  return "video";
}

function getVideoIdFromUrl(url) {
  try {
    return ytdl.getURLVideoID(url);
  } catch (_err) {
    return "";
  }
}

function chooseVideoByPreference(formats, preferredHeight) {
  const sorted = [...formats].sort((a, b) => (b.height || 0) - (a.height || 0));
  if (sorted.length === 0) return null;
  if (!preferredHeight) return sorted[0];

  const exact = sorted.find((f) => Number(f.height) === preferredHeight);
  if (exact) return exact;

  const lowerOrEqual = sorted.find((f) => Number(f.height || 0) <= preferredHeight);
  if (lowerOrEqual) return lowerOrEqual;

  return sorted[sorted.length - 1];
}

function qualityLabel(height) {
  if (height >= 4320) return `${height}p (8K)`;
  if (height >= 2160) return `${height}p (4K / Ultra HD)`;
  if (height >= 1440) return `${height}p (2K / QHD)`;
  if (height >= 1080) return `${height}p (Full HD)`;
  if (height >= 720) return `${height}p (HD)`;
  return `${height}p (SD)`;
}

function buildQualityOptions(info) {
  const heights = new Set();
  for (const f of info.formats) {
    if (f.hasVideo && Number.isFinite(f.height) && f.height > 0) {
      heights.add(Number(f.height));
    }
  }

  const options = Array.from(heights)
    .sort((a, b) => b - a)
    .map((height) => ({ value: String(height), label: qualityLabel(height) }));

  return [{ value: "best", label: "Best available (Auto)" }, ...options];
}

function tryChooseFormat(formats, quality) {
  try {
    if (!Array.isArray(formats) || formats.length === 0) return null;
    return ytdl.chooseFormat(formats, { quality });
  } catch (_err) {
    return null;
  }
}

async function getInfoWithFallback(url) {
  const attempts = [
    { playerClients: ["ANDROID", "IOS", "TVHTML5_SIMPLY_EMBEDDED_PLAYER"] },
    { playerClients: ["WEB", "IOS", "ANDROID"] },
    {}
  ];

  let lastError = null;
  for (const options of attempts) {
    try {
      const info = await ytdl.getInfo(url, options);
      if (info && Array.isArray(info.formats) && info.formats.length > 0) {
        return info;
      }
    } catch (err) {
      lastError = err;
    }
  }

  const error = new Error(
    "Video formats unavailable. Try another video or retry after some time."
  );
  error.cause = lastError;
  throw error;
}

function toItem(row) {
  return {
    id: row.id,
    url: row.url,
    videoId: row.videoId || "",
    title: row.title || "",
    filename: row.filename || "",
    qualityPreference: row.qualityPreference || "best",
    downloadType: row.downloadType || "video",
    subtitleLanguage: row.subtitleLanguage || "all",
    status: row.status,
    progress: row.progress || 0,
    message: row.message || "",
    downloadUrl: row.downloadUrl || ""
  };
}

async function loadQueue() {
  await runDb(
    `CREATE TABLE IF NOT EXISTS queue_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      videoId TEXT DEFAULT '',
      title TEXT DEFAULT '',
      filename TEXT DEFAULT '',
      qualityPreference TEXT DEFAULT 'best',
      downloadType TEXT DEFAULT 'video',
      subtitleLanguage TEXT DEFAULT 'all',
      status TEXT NOT NULL,
      progress INTEGER DEFAULT 0,
      message TEXT DEFAULT '',
      downloadUrl TEXT DEFAULT '',
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
  try {
    await runDb("ALTER TABLE queue_items ADD COLUMN qualityPreference TEXT DEFAULT 'best'");
  } catch (_err) {
    // Column already exists in existing databases.
  }
  try {
    await runDb("ALTER TABLE queue_items ADD COLUMN downloadType TEXT DEFAULT 'video'");
  } catch (_err) {
    // Column already exists in existing databases.
  }
  try {
    await runDb("ALTER TABLE queue_items ADD COLUMN subtitleLanguage TEXT DEFAULT 'all'");
  } catch (_err) {
    // Column already exists in existing databases.
  }
  try {
    await runDb("ALTER TABLE queue_items ADD COLUMN videoId TEXT DEFAULT ''");
  } catch (_err) {
    // Column already exists in existing databases.
  }

  await runDb("UPDATE queue_items SET status = 'queued', message = 'Resuming after restart...' WHERE status IN ('downloading', 'merging')");
  const rows = await allDb("SELECT * FROM queue_items ORDER BY id ASC");
  queue = rows.map(toItem);
}

async function persistItem(item) {
  await runDb(
    `UPDATE queue_items
     SET videoId = ?, title = ?, filename = ?, qualityPreference = ?, downloadType = ?, subtitleLanguage = ?, status = ?, progress = ?, message = ?, downloadUrl = ?
     WHERE id = ?`,
    [
      item.videoId || "",
      item.title,
      item.filename,
      item.qualityPreference || "best",
      item.downloadType || "video",
      item.subtitleLanguage || "all",
      item.status,
      item.progress,
      item.message,
      item.downloadUrl,
      item.id
    ]
  );
}

async function refreshQueueFromDb() {
  const rows = await allDb("SELECT * FROM queue_items ORDER BY id ASC");
  queue = rows.map(toItem);
}

function getNextQueueItems(limit) {
  const activeIds = new Set(Array.from(activeTasks.keys()));
  return queue.filter((item) => item.status === "queued" && !activeIds.has(item.id)).slice(0, limit);
}

function cleanupTempFiles(videoPath, audioPath) {
  if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
  if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
}

function shouldUseYtDlpFallback(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("playable formats") ||
    message.includes("status code: 403") ||
    message.includes("video formats unavailable") ||
    message.includes("no downloadable format")
  );
}

function parseProgressPercent(chunkText) {
  const match = chunkText.match(/(\d{1,3}(?:\.\d+)?)%/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function updateProgressInRange(item, percent, rangeStart, rangeEnd) {
  const mapped = Math.round(rangeStart + (percent / 100) * (rangeEnd - rangeStart));
  if (mapped > item.progress) {
    item.progress = mapped;
    persistItem(item).catch(() => {});
  }
}

async function runYtDlpWithProgress(item, task, ytdlpOptions, progressConfig) {
  const { message, rangeStart, rangeEnd } = progressConfig;
  item.message = message;
  item.progress = Math.max(item.progress, rangeStart);
  await persistItem(item);

  await new Promise((resolve, reject) => {
    const child = ytDlp.exec(item.url, ytdlpOptions);
    task.ytDlpProcess = child;

    const onChunk = (chunk) => {
      const percent = parseProgressPercent(String(chunk || ""));
      if (percent === null) return;
      updateProgressInRange(item, percent, rangeStart, rangeEnd);
    };

    if (child.stdout) child.stdout.on("data", onChunk);
    if (child.stderr) child.stderr.on("data", onChunk);

    child.on("error", reject);
    child.on("close", (code) => {
      task.ytDlpProcess = null;
      if (code !== 0) return reject(new Error(`yt-dlp exited with code ${code}`));
      item.progress = Math.max(item.progress, rangeEnd);
      return resolve();
    });
  });
}

async function downloadWithYtDlpFallback(item, task) {
  if (!ffmpegPath) {
    throw new Error("ffmpeg is required for yt-dlp fallback.");
  }

  const safeVideoId = sanitizeFileName(item.videoId || getVideoIdFromUrl(item.url) || "unknown_video_id");
  const outputPath = path.join(downloadsDir, `${safeVideoId}.mp4`);
  item.status = "downloading";

  await runYtDlpWithProgress(
    item,
    task,
    {
      noPlaylist: true,
      noWarnings: true,
      preferFreeFormats: true,
      format: "bv*+ba/b",
      mergeOutputFormat: "mp4",
      output: outputPath,
      ffmpegLocation: ffmpegPath
    },
    {
      message: "Retrying with yt-dlp fallback...",
      rangeStart: 5,
      rangeEnd: 98
    }
  );

  if (!fs.existsSync(outputPath)) {
    throw new Error("Fallback download finished but output file was not found.");
  }

  item.filename = path.basename(outputPath);
  item.title = item.title || item.filename.replace(".mp4", "");
  item.downloadUrl = `/downloads/${encodeURIComponent(item.filename)}`;
  item.progress = 100;
  item.status = "completed";
  item.message = "Download completed (yt-dlp fallback)";
  await persistItem(item);
}

async function downloadStreamToFile({
  info,
  format,
  outputPath,
  onProgress,
  registerStream
}) {
  return new Promise((resolve, reject) => {
    const stream = ytdl.downloadFromInfo(info, { format });
    const fileWriteStream = fs.createWriteStream(outputPath);

    registerStream(stream);

    stream.on("progress", (_chunkLength, downloaded, total) => {
      if (total > 0) onProgress(downloaded, total);
    });
    stream.on("error", (err) => reject(err));
    fileWriteStream.on("error", (err) => reject(err));
    fileWriteStream.on("finish", () => resolve());
    stream.pipe(fileWriteStream);
  });
}

async function mergeWithFfmpeg(videoPath, audioPath, outputPath, item, task) {
  if (!ffmpegPath) {
    throw new Error("ffmpeg not found. Install/resolve ffmpeg-static.");
  }

  item.status = "merging";
  item.message = "Merging best video + audio...";
  item.progress = Math.max(item.progress, 90);
  await persistItem(item);

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, [
      "-y",
      "-i",
      videoPath,
      "-i",
      audioPath,
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      outputPath
    ]);

    task.ffmpegProcess = ffmpeg;
    ffmpeg.on("error", (err) => reject(err));
    ffmpeg.on("close", (code) => {
      task.ffmpegProcess = null;
      if (code !== 0) {
        return reject(new Error(`ffmpeg exited with code ${code}`));
      }
      item.progress = 100;
      return resolve();
    });
  });
}

async function processQueueItem(item) {
  let videoTempPath = "";
  let audioTempPath = "";
  const task = {
    itemId: item.id,
    videoStream: null,
    audioStream: null,
    ffmpegProcess: null,
    ytDlpProcess: null,
    canceled: false,
    paused: false
  };
  activeTasks.set(item.id, task);

  try {
    item.status = "downloading";
    item.message = "Fetching video info...";
    item.progress = 0;
    await persistItem(item);

    const info = await getInfoWithFallback(item.url);
    const preferredHeight = parseQualityPreference(item.qualityPreference);
    const downloadType = normalizeDownloadType(item.downloadType);
    item.videoId = info.videoDetails?.videoId || item.videoId || getVideoIdFromUrl(item.url) || "";
    const videoOnly = info.formats.filter((f) => f.hasVideo && !f.hasAudio);
    const audioOnly = info.formats.filter((f) => f.hasAudio && !f.hasVideo);
    const progressiveMp4 = info.formats.filter((f) => f.hasVideo && f.hasAudio && f.container === "mp4");

    const videoFormat = chooseVideoByPreference(videoOnly, preferredHeight);
    const audioFormat = tryChooseFormat(audioOnly, "highestaudio");

    const safeVideoId = sanitizeFileName(item.videoId || "unknown_video_id");
    const outputFilename = `${safeVideoId}.mp4`;
    const outputPath = path.join(downloadsDir, outputFilename);

    item.title = info.videoDetails.title;
    item.message = "Preparing download streams...";
    item.progress = 1;
    await persistItem(item);

    if (downloadType === "mp3") {
      const mp3OutputPath = path.join(downloadsDir, `${safeVideoId}.mp3`);
      await runYtDlpWithProgress(
        item,
        task,
        {
          noPlaylist: true,
          noWarnings: true,
          extractAudio: true,
          audioFormat: "mp3",
          audioQuality: "0",
          output: mp3OutputPath,
          ffmpegLocation: ffmpegPath
        },
        {
          message: "Downloading audio (MP3)...",
          rangeStart: 5,
          rangeEnd: 98
        }
      );

      if (!fs.existsSync(mp3OutputPath)) throw new Error("MP3 output file not found.");
      item.filename = path.basename(mp3OutputPath);
      item.progress = 100;
      item.status = "completed";
      item.message = "MP3 download completed";
      item.downloadUrl = `/downloads/${encodeURIComponent(item.filename)}`;
      await persistItem(item);
      return;
    }

    item.filename = outputFilename;
    if (videoFormat && audioFormat) {
      videoTempPath = path.join(tempDir, `${safeVideoId}.video.tmp.mp4`);
      audioTempPath = path.join(tempDir, `${safeVideoId}.audio.tmp.webm`);

      item.message = "Downloading best video stream...";
      await persistItem(item);

      let videoPart = 0;
      let audioPart = 0;
      const updateCombinedProgress = async () => {
        item.progress = Math.min(89, Math.round(videoPart * 45 + audioPart * 45));
        await persistItem(item);
      };

      await downloadStreamToFile({
        info,
        format: videoFormat,
        outputPath: videoTempPath,
        onProgress: async (downloaded, total) => {
          videoPart = downloaded / total;
          await updateCombinedProgress();
        },
        registerStream: (stream) => {
          task.videoStream = stream;
        }
      });

      if (task.canceled) throw new Error("Download cancelled");

      item.message = "Downloading best audio stream...";
      await persistItem(item);

      await downloadStreamToFile({
        info,
        format: audioFormat,
        outputPath: audioTempPath,
        onProgress: async (downloaded, total) => {
          audioPart = downloaded / total;
          await updateCombinedProgress();
        },
        registerStream: (stream) => {
          task.audioStream = stream;
        }
      });

      if (task.canceled) throw new Error("Download cancelled");
      await mergeWithFfmpeg(videoTempPath, audioTempPath, outputPath, item, task);
    } else {
      const fallbackFormat = chooseVideoByPreference(progressiveMp4, preferredHeight);
      if (!fallbackFormat) {
        throw new Error("No downloadable format found for this video.");
      }

      item.message = "Downloading progressive fallback stream...";
      item.progress = 5;
      await persistItem(item);

      await downloadStreamToFile({
        info,
        format: fallbackFormat,
        outputPath,
        onProgress: async (downloaded, total) => {
          item.progress = Math.round((downloaded / total) * 100);
          await persistItem(item);
        },
        registerStream: (stream) => {
          task.videoStream = stream;
        }
      });
    }
    item.status = "completed";
    item.message = "Download completed";
    item.downloadUrl = `/downloads/${encodeURIComponent(outputFilename)}`;
    await persistItem(item);
  } catch (err) {
    if (item.status !== "paused") {
      if (shouldUseYtDlpFallback(err) && !task.canceled) {
        try {
          await downloadWithYtDlpFallback(item, task);
        } catch (fallbackErr) {
          item.status = "failed";
          item.message = fallbackErr.message || err.message || "Download failed";
          await persistItem(item);
        }
      } else {
        item.status = "failed";
        item.message = err.message || "Download failed";
        await persistItem(item);
      }
    }
  } finally {
    cleanupTempFiles(videoTempPath, audioTempPath);
    activeTasks.delete(item.id);
    await refreshQueueFromDb();
    scheduleQueueProcessing();
  }
}

function scheduleQueueProcessing() {
  const availableSlots = MAX_CONCURRENT_DOWNLOADS - activeTasks.size;
  if (availableSlots <= 0) return;
  const nextItems = getNextQueueItems(availableSlots);
  for (const item of nextItems) {
    processQueueItem(item);
  }
}

app.post("/api/queue", async (req, res) => {
  try {
    const { url, qualityPreference, downloadType } = req.body || {};
    if (!url || typeof url !== "string" || !ytdl.validateURL(url)) {
      return res.status(400).json({ error: "Please provide a valid YouTube URL." });
    }
    const normalizedQuality = qualityPreference ? String(qualityPreference) : "best";
    if (normalizedQuality !== "best" && !/^\d+$/.test(normalizedQuality)) {
      return res.status(400).json({ error: "Invalid quality preference." });
    }
    const normalizedDownloadType = normalizeDownloadType(downloadType);
    const normalizedSubtitleLanguage = "all";
    const normalizedVideoId = getVideoIdFromUrl(url);

    const normalizedUrl = url.trim();
    const existingRows = normalizedVideoId
      ? await allDb(
          "SELECT * FROM queue_items WHERE videoId = ? AND status IN ('queued','downloading','merging','paused') ORDER BY id DESC LIMIT 1",
          [normalizedVideoId]
        )
      : await allDb(
          "SELECT * FROM queue_items WHERE url = ? AND status IN ('queued','downloading','merging','paused') ORDER BY id DESC LIMIT 1",
          [normalizedUrl]
        );
    if (existingRows.length > 0 && isNonRemovableStatus(existingRows[0].status)) {
      return res.status(409).json({
        error: "This video is already active in queue.",
        existingItem: toItem(existingRows[0])
      });
    }

    const result = await runDb(
      "INSERT INTO queue_items (url, videoId, qualityPreference, downloadType, subtitleLanguage, status, progress, message) VALUES (?, ?, ?, ?, ?, 'queued', 0, 'Waiting in queue...')",
      [normalizedUrl, normalizedVideoId, normalizedQuality, normalizedDownloadType, normalizedSubtitleLanguage]
    );
    const rows = await allDb("SELECT * FROM queue_items WHERE id = ?", [result.lastID]);
    const item = toItem(rows[0]);
    queue.push(item);
    scheduleQueueProcessing();
    return res.status(201).json(item);
  } catch (err) {
    return res.status(500).json({ error: err.message || "Could not add video." });
  }
});

app.post("/api/formats", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== "string" || !ytdl.validateURL(url)) {
      return res.status(400).json({ error: "Please provide a valid YouTube URL." });
    }

    const info = await getInfoWithFallback(url.trim());
    return res.json({
      title: info.videoDetails?.title || "",
      qualities: buildQualityOptions(info)
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Could not fetch quality options." });
  }
});

app.get("/api/queue", async (_req, res) => {
  await refreshQueueFromDb();
  res.json(queue);
});

app.post("/api/queue/:id/action", async (req, res) => {
  const id = Number(req.params.id);
  const { action } = req.body || {};
  const item = queue.find((q) => q.id === id);
  if (!item) return res.status(404).json({ error: "Queue item not found." });

  if (!["pause", "resume", "cancel"].includes(action)) {
    return res.status(400).json({ error: "Invalid action." });
  }

  if (action === "pause") {
    const task = activeTasks.get(id);
    if (!task) {
      return res.status(400).json({ error: "Only current download can be paused." });
    }
    if (item.status === "merging") {
      return res.status(400).json({ error: "Pause during merge is not supported." });
    }
    if (task.videoStream) task.videoStream.pause();
    if (task.audioStream) task.audioStream.pause();
    task.paused = true;
    item.status = "paused";
    item.message = "Paused by user";
    await persistItem(item);
    return res.json(item);
  }

  if (action === "resume") {
    const task = activeTasks.get(id);
    if (item.status === "paused" && task) {
      if (task.videoStream) task.videoStream.resume();
      if (task.audioStream) task.audioStream.resume();
      task.paused = false;
      item.status = "downloading";
      item.message = "Resumed...";
      await persistItem(item);
      return res.json(item);
    }

    if (item.status === "paused") {
      item.status = "queued";
      item.message = "Resumed to queue";
      await persistItem(item);
      scheduleQueueProcessing();
      return res.json(item);
    }

    return res.status(400).json({ error: "Only paused item can be resumed." });
  }

  if (action === "cancel") {
    const task = activeTasks.get(id);
    if (task) {
      task.canceled = true;
      if (task.videoStream) task.videoStream.destroy(new Error("Canceled by user"));
      if (task.audioStream) task.audioStream.destroy(new Error("Canceled by user"));
      if (task.ffmpegProcess) task.ffmpegProcess.kill("SIGTERM");
      if (task.ytDlpProcess) task.ytDlpProcess.kill("SIGTERM");
    }
    item.status = "cancelled";
    item.message = "Cancelled by user";
    await persistItem(item);
    return res.json(item);
  }

  return res.status(400).json({ error: "Unsupported action." });
});

app.delete("/api/queue/:id", async (req, res) => {
  const id = Number(req.params.id);
  const shouldDeleteFile = String(req.query.deleteFile || "false").toLowerCase() === "true";
  const item = queue.find((q) => q.id === id);
  if (!item) return res.status(404).json({ error: "Queue item not found." });
  if (item.status === "downloading" || item.status === "merging") {
    return res.status(400).json({ error: "Use cancel for active download." });
  }

  if (shouldDeleteFile && item.filename) {
    const safeName = path.basename(item.filename);
    const filePath = path.join(downloadsDir, safeName);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        return res.status(500).json({ error: err.message || "Failed to delete associated file." });
      }
    }
  }

  await runDb("DELETE FROM queue_items WHERE id = ?", [id]);
  await refreshQueueFromDb();
  return res.status(204).send();
});

loadQueue()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`YouTube downloader running at http://localhost:${PORT}`);
    });
    scheduleQueueProcessing();
  })
  .catch((err) => {
    console.error("Failed to start app:", err);
    process.exit(1);
  });
