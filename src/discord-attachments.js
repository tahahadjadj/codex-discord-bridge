"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);

function getMessageAttachments(message) {
  const attachments = message.attachments;
  if (!attachments) {
    return [];
  }

  if (typeof attachments.values === "function") {
    return [...attachments.values()];
  }

  if (Array.isArray(attachments)) {
    return attachments;
  }

  return Object.values(attachments);
}

function isImageAttachment(attachment) {
  const contentType = String(attachment.contentType || attachment.content_type || "")
    .toLowerCase()
    .split(";")[0]
    .trim();
  if (contentType.startsWith("image/")) {
    return true;
  }

  const filename = String(attachment.name || attachment.filename || attachment.url || "");
  return IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

function sanitizeAttachmentFilename(filename, fallback = "image") {
  const parsed = path.parse(String(filename || ""));
  const base = parsed.name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const ext = IMAGE_EXTENSIONS.has(parsed.ext.toLowerCase()) ? parsed.ext.toLowerCase() : "";
  return `${base || fallback}${ext}`;
}

function extensionFromContentType(contentType) {
  const normalized = String(contentType || "").toLowerCase().split(";")[0].trim();
  if (normalized === "image/jpeg") {
    return ".jpg";
  }
  if (normalized === "image/png") {
    return ".png";
  }
  if (normalized === "image/webp") {
    return ".webp";
  }
  if (normalized === "image/gif") {
    return ".gif";
  }
  return "";
}

function attachmentFilePath({ attachment, attachmentDir, index, message }) {
  const id = attachment.id || index;
  let filename = sanitizeAttachmentFilename(attachment.name || attachment.filename || `image-${id}`);
  if (!path.extname(filename)) {
    filename += extensionFromContentType(attachment.contentType || attachment.content_type);
  }
  return path.join(attachmentDir, String(message.channelId), `${message.id}-${id}-${filename}`);
}

async function downloadDiscordImageAttachments(message, config, fetchImpl = fetch) {
  const imageAttachments = getMessageAttachments(message).filter(isImageAttachment);
  const maxCount = config.maxImageAttachments;
  const selected = imageAttachments.slice(0, maxCount);
  const skipped = [];
  const saved = [];

  for (let index = 0; index < selected.length; index += 1) {
    const attachment = selected[index];
    const size = Number(attachment.size || 0);
    if (size > config.maxImageAttachmentBytes) {
      skipped.push({
        name: attachment.name || attachment.filename || attachment.id || `image-${index + 1}`,
        reason: `larger than ${config.maxImageAttachmentBytes} bytes`
      });
      continue;
    }

    const url = attachment.url || attachment.proxyURL || attachment.proxy_url;
    if (!url) {
      skipped.push({
        name: attachment.name || attachment.filename || attachment.id || `image-${index + 1}`,
        reason: "missing attachment URL"
      });
      continue;
    }

    const filePath = attachmentFilePath({
      attachment,
      attachmentDir: config.attachmentDir,
      index,
      message
    });
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    let response;
    try {
      response = await fetchImpl(url);
    } catch (error) {
      skipped.push({
        name: attachment.name || attachment.filename || attachment.id || `image-${index + 1}`,
        reason: `download failed: ${error.message}`
      });
      continue;
    }

    if (!response.ok) {
      skipped.push({
        name: attachment.name || attachment.filename || attachment.id || `image-${index + 1}`,
        reason: `download failed with HTTP ${response.status}`
      });
      continue;
    }

    let buffer;
    try {
      buffer = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      skipped.push({
        name: attachment.name || attachment.filename || attachment.id || `image-${index + 1}`,
        reason: `download failed: ${error.message}`
      });
      continue;
    }

    if (buffer.length > config.maxImageAttachmentBytes) {
      skipped.push({
        name: attachment.name || attachment.filename || attachment.id || `image-${index + 1}`,
        reason: `downloaded file larger than ${config.maxImageAttachmentBytes} bytes`
      });
      continue;
    }

    await fs.writeFile(filePath, buffer);
    saved.push({
      attachmentId: attachment.id || null,
      contentType: attachment.contentType || attachment.content_type || null,
      name: attachment.name || attachment.filename || path.basename(filePath),
      path: filePath,
      size: buffer.length
    });
  }

  if (imageAttachments.length > selected.length) {
    skipped.push({
      name: `${imageAttachments.length - selected.length} image attachment(s)`,
      reason: `only ${maxCount} image attachment(s) are allowed per message`
    });
  }

  return {
    saved,
    skipped,
    totalImageAttachments: imageAttachments.length
  };
}

function buildCodexTurnInput(text, imagePaths = []) {
  const input = [];
  const trimmed = String(text || "").trim();
  if (trimmed) {
    input.push({ type: "text", text: trimmed });
  }

  for (const imagePath of imagePaths) {
    input.push({ type: "localImage", path: imagePath });
  }

  return input;
}

module.exports = {
  buildCodexTurnInput,
  downloadDiscordImageAttachments,
  extensionFromContentType,
  getMessageAttachments,
  isImageAttachment,
  sanitizeAttachmentFilename
};
