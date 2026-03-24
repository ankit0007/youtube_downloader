const form = document.getElementById("queue-form");
const urlInput = document.getElementById("url-input");
const statusText = document.getElementById("status-text");
const queueList = document.getElementById("queue-list");
const loadQualityBtn = document.getElementById("load-quality-btn");
const optionButtons = document.getElementById("option-buttons");

async function fetchQueue() {
  const res = await fetch("/api/queue");
  if (!res.ok) {
    throw new Error("Failed to fetch queue");
  }
  return res.json();
}

async function fetchQualities(url) {
  const res = await fetch("/api/formats", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url })
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Could not fetch quality options");
  }
  return data;
}

async function addToQueue(url, payload) {
  const res = await fetch("/api/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, ...payload })
  });
  const data = await res.json();

  if (!res.ok) {
    if (res.status === 409 && data.existingItem) {
      throw new Error(
        `${data.error} Existing item #${data.existingItem.id} is ${statusLabel(data.existingItem.status)}.`
      );
    }
    throw new Error(data.error || "Could not add video");
  }
  return data;
}

function renderOptionButtons(url, data) {
  optionButtons.innerHTML = "";

  const videoOptions = Array.isArray(data.qualities) ? data.qualities : [];

  for (const quality of videoOptions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "option-btn";
    btn.textContent = `Video ${quality.label}`;
    btn.onclick = async () => {
      try {
        statusText.textContent = `Adding video (${quality.label}) to queue...`;
        const item = await addToQueue(url, {
          downloadType: "video",
          qualityPreference: quality.value
        });
        statusText.textContent = `Added #${item.id} video ${quality.label}`;
        await refreshQueue();
      } catch (err) {
        statusText.textContent = err.message;
      }
    };
    optionButtons.appendChild(btn);
  }

  const mp3Btn = document.createElement("button");
  mp3Btn.type = "button";
  mp3Btn.className = "option-btn mp3";
  mp3Btn.textContent = "Audio MP3 (Best)";
  mp3Btn.onclick = async () => {
    try {
      statusText.textContent = "Adding MP3 to queue...";
      const item = await addToQueue(url, {
        downloadType: "mp3",
        qualityPreference: "best"
      });
      statusText.textContent = `Added #${item.id} MP3`;
      await refreshQueue();
    } catch (err) {
      statusText.textContent = err.message;
    }
  };
  optionButtons.appendChild(mp3Btn);

}

function statusLabel(status) {
  switch (status) {
    case "queued":
      return "Queued";
    case "downloading":
      return "Downloading";
    case "paused":
      return "Paused";
    case "merging":
      return "Merging";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

async function queueAction(id, action) {
  const res = await fetch(`/api/queue/${id}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action })
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Action failed");
  }
  return data;
}

function askRemoveMode() {
  const deleteFileToo = window.confirm(
    "Do you also want to delete the associated downloaded file from disk?\n\nOK = Remove from app + delete file\nCancel = Remove from app only"
  );
  return { deleteFileToo };
}

function createQueueItem(item) {
  const wrapper = document.createElement("article");
  wrapper.className = "queue-item";

  const titleText = item.title || item.url;

  wrapper.innerHTML = `
    <div class="queue-top">
      <div>
        <div class="title">${titleText}</div>
        <div class="meta">#${item.id} - ${statusLabel(item.status)} - ${item.message}</div>
        <div class="meta">Requested quality: ${item.qualityPreference === "best" ? "Auto (Best)" : `${item.qualityPreference}p`}</div>
        <div class="meta">Type: ${item.downloadType || "video"}</div>
      </div>
      <div class="meta">${item.progress || 0}%</div>
    </div>
    <div class="progress-wrapper">
      <div class="progress-bar" style="width:${item.progress || 0}%"></div>
    </div>
    <div class="actions"></div>
  `;

  const actions = wrapper.querySelector(".actions");

  if (item.status !== "downloading") {
    const removeBtn = document.createElement("button");
    removeBtn.className = "btn btn-remove";
    removeBtn.textContent = "Remove";
    removeBtn.onclick = async () => {
      try {
        const { deleteFileToo } = askRemoveMode();
        const res = await fetch(`/api/queue/${item.id}?deleteFile=${deleteFileToo ? "true" : "false"}`, {
          method: "DELETE"
        });
        if (!res.ok) {
          let errorMessage = "Could not remove item.";
          try {
            const data = await res.json();
            errorMessage = data.error || errorMessage;
          } catch (_err) {
            // ignore json parse failure
          }
          throw new Error(errorMessage);
        }
        statusText.textContent = deleteFileToo
          ? "Removed item and deleted associated file."
          : "Removed item from app.";
        await refreshQueue();
      } catch (err) {
        statusText.textContent = err.message;
      }
    };
    actions.appendChild(removeBtn);
  }

  if (item.status === "downloading") {
    const pauseBtn = document.createElement("button");
    pauseBtn.className = "btn btn-pause";
    pauseBtn.textContent = "Pause";
    pauseBtn.onclick = async () => {
      try {
        await queueAction(item.id, "pause");
        await refreshQueue();
      } catch (err) {
        statusText.textContent = err.message;
      }
    };
    actions.appendChild(pauseBtn);
  }

  if (item.status === "paused") {
    const resumeBtn = document.createElement("button");
    resumeBtn.className = "btn btn-resume";
    resumeBtn.textContent = "Resume";
    resumeBtn.onclick = async () => {
      try {
        await queueAction(item.id, "resume");
        await refreshQueue();
      } catch (err) {
        statusText.textContent = err.message;
      }
    };
    actions.appendChild(resumeBtn);
  }

  if (item.status === "downloading" || item.status === "paused" || item.status === "merging") {
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.onclick = async () => {
      try {
        await queueAction(item.id, "cancel");
        await refreshQueue();
      } catch (err) {
        statusText.textContent = err.message;
      }
    };
    actions.appendChild(cancelBtn);
  }

  if (item.status === "completed" && item.downloadUrl) {
    const link = document.createElement("a");
    link.className = "btn btn-download";
    link.href = item.downloadUrl;
    link.textContent = "Download File";
    link.download = item.filename || "";
    actions.appendChild(link);
  }

  return wrapper;
}

async function refreshQueue() {
  try {
    const items = await fetchQueue();
    queueList.innerHTML = "";

    if (items.length === 0) {
      queueList.innerHTML = "<p>No videos in queue.</p>";
      return;
    }

    for (const item of items) {
      queueList.appendChild(createQueueItem(item));
    }
  } catch (err) {
    statusText.textContent = err.message;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
});

loadQualityBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) {
    statusText.textContent = "Please paste YouTube URL first.";
    return;
  }

  statusText.textContent = "Loading available qualities...";
  loadQualityBtn.disabled = true;
  try {
    const data = await fetchQualities(url);
    renderOptionButtons(url, data);
    statusText.textContent = data.title
      ? `Options loaded for: ${data.title}. Click any button to queue.`
      : "Options loaded. Click any button to queue.";
  } catch (err) {
    statusText.textContent = err.message;
    optionButtons.innerHTML = "";
  } finally {
    loadQualityBtn.disabled = false;
  }
});

setInterval(refreshQueue, 1500);
refreshQueue();
