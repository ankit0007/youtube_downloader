require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const ytdl = require("@distube/ytdl-core");
const ffmpegPath = require("ffmpeg-static");
const ytDlp = require("yt-dlp-exec");

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_CONCURRENT_DOWNLOADS = 5;

const downloadsDir = path.join(__dirname, "downloads");
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

const db = new sqlite3.Database(path.join(__dirname, "queue.db"));

app.use(express.json());

let queue = [];
const activeTasks = new Map();

function withYtDlpDefaults(options = {}) {
  return {
    noPlaylist: true,
    noWarnings: true,
    // Force JS runtime for YouTube extraction compatibility.
    jsRuntimes: "node",
    ...options
  };
}

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

function getQualitySuffix(qualityPreference) {
  if (!qualityPreference || qualityPreference === "best") return "best";
  if (/^\d+$/.test(String(qualityPreference))) return String(qualityPreference);
  return "best";
}

function getVideoIdFromUrl(url) {
  try {
    return ytdl.getURLVideoID(url);
  } catch (_err) {
    return "";
  }
}

function qualityLabel(height) {
  if (height >= 4320) return `${height}p (8K)`;
  if (height >= 2160) return `${height}p (4K / Ultra HD)`;
  if (height >= 1440) return `${height}p (2K / QHD)`;
  if (height >= 1080) return `${height}p (Full HD)`;
  if (height >= 720) return `${height}p (HD)`;
  return `${height}p (SD)`;
}

function buildQualityOptionsFromMetadata(metadata) {
  const formats = Array.isArray(metadata?.formats) ? metadata.formats : [];
  const heights = new Set();
  for (const f of formats) {
    const hasVideo = f?.vcodec && f.vcodec !== "none";
    const height = Number(f?.height || 0);
    if (hasVideo && Number.isFinite(height) && height > 0) {
      heights.add(height);
    }
  }

  const options = Array.from(heights)
    .sort((a, b) => b - a)
    .map((height) => ({ value: String(height), label: qualityLabel(height) }));

  return [{ value: "best", label: "Best available (Auto)" }, ...options];
}

/** YouTube Media Downloader (DataFanatic) — search uses GET /v2/search/videos */
const RAPIDAPI_MEDIA_DOWNLOADER_HOST = "youtube-media-downloader.p.rapidapi.com";
const RAPIDAPI_SEARCH_PATH_DEFAULT = "/v2/search/videos";
const RAPIDAPI_SEARCH_MAX = 30;

function parseLengthTextToSeconds(text) {
  if (text == null || text === "") return null;
  const parts = String(text)
    .trim()
    .split(":")
    .map((p) => parseInt(p, 10));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

function pickBestThumbnailUrl(thumbnails) {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return "";
  const best = [...thumbnails].sort(
    (a, b) => (Number(b.width) || 0) - (Number(a.width) || 0)
  )[0];
  return best && best.url ? String(best.url) : "";
}

function extractSearchResultRows(json) {
  if (!json || typeof json !== "object") return [];
  if (Array.isArray(json)) return json;
  const keys = ["data", "contents", "videos", "items", "results", "result", "searchResults"];
  for (const k of keys) {
    if (Array.isArray(json[k])) {
      const arr = json[k];
      if (k === "contents") {
        return arr.map((cell) => cell?.video || cell?.playlist || cell).filter(Boolean);
      }
      return arr;
    }
  }
  return [];
}

function normalizeVideoSearchHit(raw) {
  if (!raw || typeof raw !== "object") return null;
  const nested = raw.video && typeof raw.video === "object" ? raw.video : null;
  const base = nested || raw;

  let videoId =
    base.videoId ||
    base.id ||
    (base.id && typeof base.id === "object" ? base.id.videoId : null) ||
    "";
  videoId = String(videoId || "").trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return null;

  const title =
    base.title ||
    base.videoTitle ||
    raw.title ||
    "YouTube video";

  let thumbnailUrl = "";
  if (typeof base.thumbnail === "string") thumbnailUrl = base.thumbnail;
  if (!thumbnailUrl && Array.isArray(base.thumbnails)) {
    thumbnailUrl = pickBestThumbnailUrl(base.thumbnails);
  }
  if (!thumbnailUrl && Array.isArray(base.thumbnail)) {
    thumbnailUrl = pickBestThumbnailUrl(base.thumbnail);
  }

  const channel =
    base.channelTitle ||
    (typeof base.channel === "string" ? base.channel : "") ||
    (base.channel && base.channel.name) ||
    base.author ||
    raw.channelTitle ||
    "";

  let durationSec = null;
  if (typeof base.duration === "number" && Number.isFinite(base.duration)) {
    durationSec = base.duration;
  }
  if (durationSec == null) {
    durationSec =
      parseLengthTextToSeconds(base.lengthText) ||
      parseLengthTextToSeconds(typeof base.duration === "string" ? base.duration : "");
  }

  return {
    videoId,
    title,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnailUrl: thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    channel,
    durationSec
  };
}

async function searchYouTubeRapidApi(query, limit, filters = {}) {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error(
      "RAPIDAPI_KEY is not set. Subscribe to YouTube Media Downloader on RapidAPI, put the key in .env (see README), restart the server."
    );
  }
  const q = String(query || "").trim();
  if (!q) return [];

  const max = Math.min(Math.max(Number(limit) || 20, 1), RAPIDAPI_SEARCH_MAX);

  const host = String(process.env.RAPIDAPI_HOST || RAPIDAPI_MEDIA_DOWNLOADER_HOST).trim();
  const pathRaw = String(process.env.RAPIDAPI_SEARCH_PATH || RAPIDAPI_SEARCH_PATH_DEFAULT).trim();
  const path = pathRaw.startsWith("/") ? pathRaw : `/${pathRaw}`;

  const params = new URLSearchParams();
  params.set("query", q);
  if (filters.duration) params.set("duration", String(filters.duration));
  if (filters.upload_date) params.set("uploadDate", String(filters.upload_date));
  if (filters.sort_by) params.set("sortBy", String(filters.sort_by));

  const url = `https://${host}${path}?${params.toString()}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "x-rapidapi-host": host,
      "x-rapidapi-key": apiKey.trim()
    }
  });

  const rawText = await res.text();
  let json = {};
  try {
    json = rawText ? JSON.parse(rawText) : {};
  } catch (_err) {
    throw new Error("RapidAPI returned invalid JSON.");
  }

  if (!res.ok) {
    const msg =
      (typeof json.message === "string" && json.message) ||
      (typeof json.msg === "string" && json.msg) ||
      rawText.slice(0, 200) ||
      `RapidAPI HTTP ${res.status}`;
    throw new Error(msg);
  }

  const rows = extractSearchResultRows(json);
  const results = rows.map((row) => normalizeVideoSearchHit(row)).filter(Boolean);
  return results.slice(0, max);
}

async function getVideoMetadataWithYtDlp(url) {
  return new Promise((resolve, reject) => {
    const child = ytDlp.exec(
      url,
      withYtDlpDefaults({
        dumpSingleJson: true,
        skipDownload: true
      })
    );

    let stdoutData = "";
    let stderrData = "";
    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdoutData += String(chunk || "");
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderrData += String(chunk || "");
      });
    }

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(stderrData || `yt-dlp metadata exited with code ${code}`));
      }
      try {
        const json = JSON.parse(stdoutData);
        return resolve(json);
      } catch (_err) {
        return reject(new Error("Failed to parse yt-dlp metadata output."));
      }
    });
  });
}

function toItem(row) {
  const idNum = Number(row.id);
  return {
    id: Number.isFinite(idNum) ? idNum : row.id,
    url: row.url,
    videoId: row.videoId || "",
    title: row.title || "",
    thumbnailUrl: row.thumbnailUrl || "",
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

const MAX_BULK_QUEUE_ADD = 50;
const MAX_BULK_QUEUE_DELETE = 100;

async function insertQueueItemIfEligible(url, qualityPreference, downloadType) {
  if (url == null || typeof url !== "string" || !url.trim()) {
    return { ok: false, error: "Please provide a valid YouTube URL." };
  }
  const normalizedUrl = url.trim();
  if (!ytdl.validateURL(normalizedUrl)) {
    return { ok: false, error: "Please provide a valid YouTube URL." };
  }
  const normalizedQuality = qualityPreference ? String(qualityPreference) : "best";
  if (normalizedQuality !== "best" && !/^\d+$/.test(normalizedQuality)) {
    return { ok: false, error: "Invalid quality preference." };
  }
  const normalizedDownloadType = normalizeDownloadType(downloadType);
  const normalizedSubtitleLanguage = "all";
  const normalizedVideoId = getVideoIdFromUrl(normalizedUrl);

  const existingRows = normalizedVideoId
    ? await allDb(
        "SELECT * FROM queue_items WHERE videoId = ? AND downloadType = ? AND qualityPreference = ? AND status IN ('queued','downloading','merging','paused') ORDER BY id DESC LIMIT 1",
        [normalizedVideoId, normalizedDownloadType, normalizedQuality]
      )
    : await allDb(
        "SELECT * FROM queue_items WHERE url = ? AND downloadType = ? AND qualityPreference = ? AND status IN ('queued','downloading','merging','paused') ORDER BY id DESC LIMIT 1",
        [normalizedUrl, normalizedDownloadType, normalizedQuality]
      );
  if (existingRows.length > 0 && isNonRemovableStatus(existingRows[0].status)) {
    return {
      ok: false,
      code: "duplicate_active",
      error: "This video is already active in queue.",
      existingItem: toItem(existingRows[0])
    };
  }

  const result = await runDb(
    "INSERT INTO queue_items (url, videoId, qualityPreference, downloadType, subtitleLanguage, status, progress, message) VALUES (?, ?, ?, ?, ?, 'queued', 0, 'Waiting in queue...')",
    [normalizedUrl, normalizedVideoId, normalizedQuality, normalizedDownloadType, normalizedSubtitleLanguage]
  );
  const rows = await allDb("SELECT * FROM queue_items WHERE id = ?", [result.lastID]);
  const item = toItem(rows[0]);
  queue.push(item);
  return { ok: true, item };
}

async function deleteQueueItemRow(id, shouldDeleteFile) {
  const rows = await allDb("SELECT * FROM queue_items WHERE id = ?", [id]);
  if (!rows.length) return { ok: false, reason: "not_found" };
  const item = toItem(rows[0]);
  if (item.status === "downloading" || item.status === "merging") {
    return { ok: false, reason: "active_download" };
  }
  if (shouldDeleteFile && item.filename) {
    const safeName = path.basename(item.filename);
    const filePath = path.join(downloadsDir, safeName);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        return { ok: false, reason: "file_delete_failed", message: err.message };
      }
    }
  }
  await runDb("DELETE FROM queue_items WHERE id = ?", [id]);
  return { ok: true };
}

async function pruneCompletedMissingFiles() {
  const rows = await allDb(
    "SELECT id, filename FROM queue_items WHERE status = 'completed' AND filename IS NOT NULL AND filename != ''"
  );
  for (const row of rows) {
    const filePath = path.join(downloadsDir, path.basename(row.filename));
    if (!fs.existsSync(filePath)) {
      await runDb("DELETE FROM queue_items WHERE id = ?", [row.id]);
    }
  }
}

async function loadQueue() {
  await runDb(
    `CREATE TABLE IF NOT EXISTS queue_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      videoId TEXT DEFAULT '',
      title TEXT DEFAULT '',
      thumbnailUrl TEXT DEFAULT '',
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
  try {
    await runDb("ALTER TABLE queue_items ADD COLUMN thumbnailUrl TEXT DEFAULT ''");
  } catch (_err) {
    // Column already exists in existing databases.
  }

  await runDb("UPDATE queue_items SET status = 'queued', message = 'Resuming after restart...' WHERE status IN ('downloading', 'merging')");
  const rows = await allDb("SELECT * FROM queue_items ORDER BY id DESC");
  queue = rows.map(toItem);
}

async function persistItem(item) {
  await runDb(
    `UPDATE queue_items
     SET videoId = ?, title = ?, thumbnailUrl = ?, filename = ?, qualityPreference = ?, downloadType = ?, subtitleLanguage = ?, status = ?, progress = ?, message = ?, downloadUrl = ?
     WHERE id = ?`,
    [
      item.videoId || "",
      item.title,
      item.thumbnailUrl || "",
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
  await pruneCompletedMissingFiles();
  const rows = await allDb("SELECT * FROM queue_items ORDER BY id DESC");
  queue = rows.map(toItem);
}

function getNextQueueItems(limit) {
  const activeIds = new Set(Array.from(activeTasks.keys()));
  return queue.filter((item) => item.status === "queued" && !activeIds.has(item.id)).slice(0, limit);
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
    const child = ytDlp.exec(item.url, withYtDlpDefaults(ytdlpOptions));
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
  const qualitySuffix = getQualitySuffix(item.qualityPreference);
  const outputBase = `${safeVideoId}_${qualitySuffix}`;
  const outputTemplate = path.join(downloadsDir, `${outputBase}.%(ext)s`);
  item.status = "downloading";

  await runYtDlpWithProgress(
    item,
    task,
    {
      noPlaylist: true,
      noWarnings: true,
      preferFreeFormats: true,
      // Use single playable stream to avoid broken merge edge-cases.
      format: "best[ext=mp4]/best",
      output: outputTemplate,
      ffmpegLocation: ffmpegPath
    },
    {
      message: "Retrying with yt-dlp fallback...",
      rangeStart: 5,
      rangeEnd: 98
    }
  );

  const preferredCandidates = [`${outputBase}.mp4`, `${outputBase}.webm`, `${outputBase}.mkv`];
  const existingPreferred = preferredCandidates.find((name) => {
    const candidatePath = path.join(downloadsDir, name);
    return fs.existsSync(candidatePath);
  });

  const fallbackCandidate =
    fs
      .readdirSync(downloadsDir)
      .find((name) => {
        if (!name.startsWith(`${outputBase}.`)) return false;
        const ext = path.extname(name).toLowerCase();
        return [".mp4", ".webm", ".mkv"].includes(ext);
      }) || "";

  const finalFileName = existingPreferred || fallbackCandidate;
  if (!finalFileName) {
    throw new Error("Fallback download finished but output file was not found.");
  }

  item.filename = finalFileName;
  item.title = item.title || item.filename.replace(path.extname(item.filename), "");
  item.downloadUrl = `/downloads/${encodeURIComponent(item.filename)}`;
  item.progress = 100;
  item.status = "completed";
  item.message = "Download completed (yt-dlp fallback)";
  await persistItem(item);
}

async function downloadVideoWithYtDlp(item, task, safeVideoId, preferredHeight) {
  const qualitySuffix = getQualitySuffix(item.qualityPreference);
  const outputBase = `${safeVideoId}_${qualitySuffix}`;
  const outputTemplate = path.join(downloadsDir, `${outputBase}.%(ext)s`);
  const formatSelector = preferredHeight
    ? `bestvideo[height<=${preferredHeight}]+bestaudio/best[height<=${preferredHeight}]/best`
    : "bestvideo+bestaudio/best";

  await runYtDlpWithProgress(
    item,
    task,
    {
      noPlaylist: true,
      noWarnings: true,
      format: formatSelector,
      mergeOutputFormat: "mp4",
      output: outputTemplate,
      ffmpegLocation: ffmpegPath
    },
    {
      message: "Downloading video...",
      rangeStart: 5,
      rangeEnd: 98
    }
  );

  const candidates = [`${outputBase}.mp4`, `${outputBase}.webm`, `${outputBase}.mkv`];
  const fileName = candidates.find((name) => fs.existsSync(path.join(downloadsDir, name)));
  if (!fileName) {
    throw new Error("Video output file was not found.");
  }

  item.filename = fileName;
  item.progress = 100;
  item.status = "completed";
  item.message = "Video download completed";
  item.downloadUrl = `/downloads/${encodeURIComponent(item.filename)}`;
  await persistItem(item);
}

async function processQueueItem(item) {
  const task = {
    itemId: item.id,
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

    const metadata = await getVideoMetadataWithYtDlp(item.url);
    const preferredHeight = parseQualityPreference(item.qualityPreference);
    const downloadType = normalizeDownloadType(item.downloadType);
    item.videoId = metadata?.id || item.videoId || getVideoIdFromUrl(item.url) || "";

    const safeVideoId = sanitizeFileName(item.videoId || "unknown_video_id");
    item.title = metadata?.title || item.title;
    const thumbnails = Array.isArray(metadata?.thumbnails) ? metadata.thumbnails : [];
    item.thumbnailUrl = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url || "" : "";
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

    await downloadVideoWithYtDlp(item, task, safeVideoId, preferredHeight);
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
    const r = await insertQueueItemIfEligible(url, qualityPreference, downloadType);
    if (!r.ok) {
      if (r.code === "duplicate_active") {
        return res.status(409).json({
          error: r.error || "This video is already active in queue.",
          existingItem: r.existingItem
        });
      }
      return res.status(400).json({ error: r.error || "Could not add video." });
    }
    scheduleQueueProcessing();
    return res.status(201).json(r.item);
  } catch (err) {
    return res.status(500).json({ error: err.message || "Could not add video." });
  }
});

app.post("/api/queue/bulk", async (req, res) => {
  try {
    const { items: rawItems } = req.body || {};
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return res.status(400).json({ error: "Provide a non-empty items array." });
    }
    if (rawItems.length > MAX_BULK_QUEUE_ADD) {
      return res.status(400).json({ error: `Too many items (max ${MAX_BULK_QUEUE_ADD} per request).` });
    }
    const created = [];
    const errors = [];
    for (let i = 0; i < rawItems.length; i++) {
      const entry = rawItems[i] || {};
      const r = await insertQueueItemIfEligible(entry.url, entry.qualityPreference, entry.downloadType);
      if (r.ok) {
        created.push(r.item);
      } else {
        errors.push({
          index: i,
          url: typeof entry.url === "string" ? entry.url.trim() : "",
          error: r.error || "Could not add",
          code: r.code || "invalid",
          existingItem: r.existingItem
        });
      }
    }
    scheduleQueueProcessing();
    return res.json({ created, errors });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Bulk add failed." });
  }
});

app.post("/api/formats", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== "string" || !ytdl.validateURL(url)) {
      return res.status(400).json({ error: "Please provide a valid YouTube URL." });
    }

    const metadata = await getVideoMetadataWithYtDlp(url.trim());
    return res.json({
      title: metadata?.title || "",
      qualities: buildQualityOptionsFromMetadata(metadata)
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Could not fetch quality options." });
  }
});

app.post("/api/search", async (req, res) => {
  try {
    const { q, limit, duration, upload_date, sort_by } = req.body || {};
    if (q == null || typeof q !== "string" || !q.trim()) {
      return res.status(400).json({ error: "Please provide a search query." });
    }
    const filters = {};
    if (duration != null && String(duration).trim()) filters.duration = String(duration).trim();
    if (upload_date != null && String(upload_date).trim()) {
      filters.upload_date = String(upload_date).trim();
    }
    if (sort_by != null && String(sort_by).trim()) filters.sort_by = String(sort_by).trim();

    const results = await searchYouTubeRapidApi(q.trim(), limit, filters);
    return res.json({ results });
  } catch (err) {
    const msg = err.message || "Search failed.";
    const status = msg.includes("RAPIDAPI_KEY") ? 503 : 500;
    return res.status(status).json({ error: msg });
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
    return res.status(400).json({ error: "Pause is not supported in current download engine." });
  }

  if (action === "resume") {
    return res.status(400).json({ error: "Resume is not supported in current download engine." });
  }

  if (action === "cancel") {
    const task = activeTasks.get(id);
    if (task) {
      task.canceled = true;
      if (task.ytDlpProcess) task.ytDlpProcess.kill("SIGTERM");
    }
    item.status = "cancelled";
    item.message = "Cancelled by user";
    await persistItem(item);
    return res.json(item);
  }

  return res.status(400).json({ error: "Unsupported action." });
});

app.post("/api/queue/bulk-delete", async (req, res) => {
  try {
    const { ids, deleteFile } = req.body || {};
    const shouldDeleteFile = Boolean(deleteFile);
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "Provide a non-empty ids array." });
    }
    if (ids.length > MAX_BULK_QUEUE_DELETE) {
      return res.status(400).json({ error: `Too many ids (max ${MAX_BULK_QUEUE_DELETE}).` });
    }
    const uniqueIds = [
      ...new Set(
        ids
          .map((raw) => {
            const n = parseInt(String(raw === null || raw === undefined ? "" : raw), 10);
            return Number.isFinite(n) && n > 0 ? n : null;
          })
          .filter((n) => n != null)
      )
    ];
    const removed = [];
    const skipped = [];
    for (const id of uniqueIds) {
      const result = await deleteQueueItemRow(id, shouldDeleteFile);
      if (result.ok) {
        removed.push(id);
      } else {
        skipped.push({
          id,
          reason: result.reason,
          message: result.message
        });
      }
    }
    await refreshQueueFromDb();
    return res.json({ removed, skipped });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Bulk delete failed." });
  }
});

app.delete("/api/queue/:id", async (req, res) => {
  const id = Number(req.params.id);
  const shouldDeleteFile = String(req.query.deleteFile || "false").toLowerCase() === "true";
  const result = await deleteQueueItemRow(id, shouldDeleteFile);
  if (!result.ok) {
    if (result.reason === "not_found") {
      return res.status(404).json({ error: "Queue item not found." });
    }
    if (result.reason === "active_download") {
      return res.status(400).json({ error: "Use cancel for active download." });
    }
    if (result.reason === "file_delete_failed") {
      return res.status(500).json({ error: result.message || "Failed to delete associated file." });
    }
    return res.status(400).json({ error: "Could not remove item." });
  }
  await refreshQueueFromDb();
  return res.status(204).send();
});

app.use("/downloads", express.static(downloadsDir));
app.use(express.static(path.join(__dirname, "public")));

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
