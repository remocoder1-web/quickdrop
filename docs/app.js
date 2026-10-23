
const API_BASE = "https://quickdrop-api-9k3g.onrender.com";

const fileInput = document.getElementById("fileInput");
const dropzone = document.getElementById("dropzone");
const selectedFile = document.getElementById("selectedFile");
const sendButton = document.getElementById("sendButton");
const receiveButton = document.getElementById("receiveButton");
const codeInput = document.getElementById("codeInput");
const sendResult = document.getElementById("sendResult");
const receiveResult = document.getElementById("receiveResult");

const sendTab = document.getElementById("sendTab");
const receiveTab = document.getElementById("receiveTab");
const sendPanel = document.getElementById("sendPanel");
const receivePanel = document.getElementById("receivePanel");

const MAX_FILE_SIZE = 100 * 1024 * 1024;

function showMessage(element, message) {
  element.textContent = message;
}

function setBusy(button, busy, busyText, normalText) {
  button.disabled = busy;
  button.textContent = busy ? busyText : normalText;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function switchTab(tab) {
  const sending = tab === "send";

  sendPanel.hidden = !sending;
  receivePanel.hidden = sending;

  sendTab.classList.toggle("active", sending);
  receiveTab.classList.toggle("active", !sending);

  sendTab.setAttribute("aria-pressed", String(sending));
  receiveTab.setAttribute("aria-pressed", String(!sending));
}

sendTab.addEventListener("click", () => switchTab("send"));
receiveTab.addEventListener("click", () => switchTab("receive"));

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];

  sendResult.textContent = "";
  selectedFile.hidden = true;
  sendButton.disabled = true;

  if (!file) return;

  if (file.size < 1) {
    showMessage(sendResult, "This file is empty. Please choose another file.");
    fileInput.value = "";
    return;
  }

  if (file.size > MAX_FILE_SIZE) {
    showMessage(sendResult, "The maximum file size is 100 MB.");
    fileInput.value = "";
    return;
  }

  selectedFile.textContent = `${file.name} · ${formatBytes(file.size)}`;
  selectedFile.hidden = false;
  sendButton.disabled = false;
});

dropzone.addEventListener("dragover", event => {
  event.preventDefault();
  dropzone.style.borderColor = "var(--accent)";
});

dropzone.addEventListener("dragleave", () => {
  dropzone.style.borderColor = "";
});

dropzone.addEventListener("drop", event => {
  event.preventDefault();
  dropzone.style.borderColor = "";

  const file = event.dataTransfer.files[0];

  if (!file) return;

  const transfer = new DataTransfer();
  transfer.items.add(file);
  fileInput.files = transfer.files;
  fileInput.dispatchEvent(new Event("change"));
});

async function apiPost(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Something went wrong. Please try again.");
  }

  return data;
}

sendButton.addEventListener("click", async () => {
  const file = fileInput.files[0];

  if (!file) {
    showMessage(sendResult, "Please choose a file first.");
    return;
  }

  setBusy(sendButton, true, "Preparing upload...", "Generate sharing code");
  showMessage(sendResult, "Preparing your secure upload...");

  try {
    const transfer = await apiPost("/api/create", {
      fileName: file.name,
      contentType: file.type || "application/octet-stream",
      size: file.size
    });

    const uploadResponse = await fetch(transfer.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "x-upsert": "false"
      },
      body: file
    });

    if (!uploadResponse.ok) {
      throw new Error("Upload failed. Please try again.");
    }

    await apiPost("/api/complete", { code: transfer.code });

    sendResult.replaceChildren();

    const heading = document.createElement("p");
    heading.textContent = "Your sharing code is:";

    const code = document.createElement("p");
    code.textContent = transfer.code;
    code.style.fontSize = "2rem";
    code.style.fontWeight = "800";
    code.style.letterSpacing = "6px";

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "primary-button";
    copyButton.textContent = "Copy code";

    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(transfer.code);
        copyButton.textContent = "Copied!";
      } catch {
        copyButton.textContent = "Copy unavailable — select the code above";
      }
    });

    const expiry = document.createElement("p");
    expiry.textContent = "This code expires in 10 minutes. Share it only with your recipient.";

    sendResult.append(heading, code, copyButton, expiry);
  } catch (error) {
    showMessage(sendResult, error.message);
  } finally {
    setBusy(sendButton, false, "Preparing upload...", "Generate sharing code");
  }
});

codeInput.addEventListener("input", () => {
  codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 6);
  receiveResult.textContent = "";
});

receiveButton.addEventListener("click", async () => {
  const code = codeInput.value.trim();

  if (!/^\d{6}$/.test(code)) {
    showMessage(receiveResult, "Enter a valid six-digit code.");
    return;
  }

  setBusy(receiveButton, true, "Finding file...", "Find my file");
  showMessage(receiveResult, "Checking your code...");

  try {
    const result = await apiPost("/api/receive", { code });

    receiveResult.replaceChildren();

    const name = document.createElement("p");
    name.textContent = `File ready: ${result.fileName} (${formatBytes(result.size)})`;

    const link = document.createElement("a");
    link.href = result.downloadUrl;
    link.textContent = "Download file";
    link.setAttribute("download", result.fileName);

    receiveResult.append(name, link);
  } catch (error) {
    showMessage(receiveResult, error.message);
  } finally {
    setBusy(receiveButton, false, "Finding file...", "Find my file");
  }
});

switchTab("send");
