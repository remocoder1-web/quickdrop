
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN }));
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const CODE_LIFETIME_MS = 10 * 60 * 1000;

const requiredEnv = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CODE_PEPPER",
  "FRONTEND_ORIGIN"
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const BUCKET = "quickdrop";

function hashCode(code) {
  return crypto
    .createHmac("sha256", process.env.CODE_PEPPER)
    .update(code)
    .digest("hex");
}

function validCode(code) {
  return typeof code === "string" && /^\d{6}$/.test(code);
}

function newCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function safeFileName(name) {
  return String(name || "file")
    .replace(/[\/\\]/g, "_")
    .replace(/[\r\n\0]/g, "_")
    .slice(0, 200);
}

async function findTransfer(code) {
  if (!validCode(code)) return null;

  const { data, error } = await supabase
    .from("transfers")
    .select("*")
    .eq("code_hash", hashCode(code))
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  if (new Date(data.expires_at).getTime() <= Date.now()) {
    return null;
  }

  return data;
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/config", (req, res) => {
  res.json({
    maxFileSize: MAX_FILE_SIZE,
    lifetimeSeconds: CODE_LIFETIME_MS / 1000
  });
});

app.post("/api/create", async (req, res) => {
  try {
    const { fileName, contentType, size } = req.body || {};

    if (
      typeof fileName !== "string" ||
      !fileName.trim() ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > MAX_FILE_SIZE
    ) {
      return res.status(400).json({
        error: "Choose a file smaller than or equal to 100 MB."
      });
    }

    let code;
    let transfer;
    let objectPath;

    for (let attempt = 0; attempt < 5; attempt++) {
      code = newCode();
      const id = crypto.randomUUID();
      objectPath = `${id}`;
      transfer = {
        id,
        code_hash: hashCode(code),
        object_path: objectPath,
        file_name: safeFileName(fileName),
        content_type:
          typeof contentType === "string"
            ? contentType.slice(0, 200)
            : "application/octet-stream",
        size_bytes: size,
        expires_at: new Date(Date.now() + CODE_LIFETIME_MS).toISOString(),
        uploaded: false
      };

      const { error } = await supabase.from("transfers").insert(transfer);

      if (!error) break;

      if (error.code === "23505") {
        transfer = null;
        continue;
      }

      throw error;
    }

    if (!transfer) {
      return res.status(503).json({
        error: "Could not create a code. Please try again."
      });
    }

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(objectPath, { upsert: false });

    if (error) {
      await supabase.from("transfers").delete().eq("id", transfer.id);
      throw error;
    }

    res.json({
      code,
      expiresAt: transfer.expires_at,
      uploadUrl: data.signedUrl,
      uploadToken: data.token,
      objectPath
    });
  } catch (error) {
    console.error("Create error:", error.message);
    res.status(500).json({ error: "Could not start the upload." });
  }
});

app.post("/api/complete", async (req, res) => {
  try {
    const { code } = req.body || {};
    const transfer = await findTransfer(code);

    if (!transfer) {
      return res.status(404).json({
        error: "Code not found or expired."
      });
    }

    const { data: files, error: listError } = await supabase.storage
      .from(BUCKET)
      .list("", { search: transfer.object_path, limit: 10 });

    if (listError) throw listError;

    const uploadedFile = (files || []).find(
      file => file.name === transfer.object_path
    );

    if (!uploadedFile) {
      return res.status(400).json({
        error: "Upload not found. Please upload the file again."
      });
    }

    if (
      uploadedFile.metadata &&
      Number(uploadedFile.metadata.size) !== Number(transfer.size_bytes)
    ) {
      await supabase.storage.from(BUCKET).remove([transfer.object_path]);
      return res.status(400).json({
        error: "Uploaded file size does not match."
      });
    }

    const { error } = await supabase
      .from("transfers")
      .update({ uploaded: true })
      .eq("id", transfer.id);

    if (error) throw error;

    res.json({ ok: true });
  } catch (error) {
    console.error("Complete error:", error.message);
    res.status(500).json({ error: "Could not verify the upload." });
  }
});

app.post("/api/receive", async (req, res) => {
  try {
    const { code } = req.body || {};
    const transfer = await findTransfer(code);

    if (!transfer || !transfer.uploaded) {
      return res.status(404).json({
        error: "Invalid code, expired code, or file not ready."
      });
    }

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(transfer.object_path, 60);

    if (error) throw error;

    res.json({
      downloadUrl: data.signedUrl,
      fileName: transfer.file_name,
      contentType: transfer.content_type,
      size: Number(transfer.size_bytes)
    });
  } catch (error) {
    console.error("Receive error:", error.message);
    res.status(500).json({ error: "Could not prepare the download." });
  }
});

app.listen(PORT, () => {
  console.log(`QuickDrop backend running on port ${PORT}`);
});
