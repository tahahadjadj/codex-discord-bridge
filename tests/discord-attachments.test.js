"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  buildCodexTurnInput,
  downloadDiscordImageAttachments,
  extensionFromContentType,
  getMessageAttachments,
  isImageAttachment,
  sanitizeAttachmentFilename
} = require("../src/discord-attachments");

describe("discord attachment helpers", () => {
  test("detects image attachments by content type or extension", () => {
    expect(isImageAttachment({ contentType: "image/png", name: "file.bin" })).toBe(true);
    expect(isImageAttachment({ contentType: "application/octet-stream", name: "photo.jpg" })).toBe(true);
    expect(isImageAttachment({ contentType: "application/pdf", name: "doc.pdf" })).toBe(false);
  });

  test("extracts attachments from Discord collection-like objects", () => {
    const values = [{ id: "1" }, { id: "2" }];
    expect(getMessageAttachments({ attachments: new Map(values.map((item) => [item.id, item])) }))
      .toEqual(values);
  });

  test("sanitizes attachment filenames", () => {
    expect(sanitizeAttachmentFilename("../My Screenshot 1.PNG")).toBe("my-screenshot-1.png");
    expect(sanitizeAttachmentFilename("")).toBe("image");
    expect(extensionFromContentType("image/jpeg")).toBe(".jpg");
  });

  test("builds Codex input from text and image paths", () => {
    expect(buildCodexTurnInput(" hello ", ["/tmp/a.png"])).toEqual([
      { type: "text", text: "hello" },
      { type: "localImage", path: "/tmp/a.png" }
    ]);
    expect(buildCodexTurnInput("", ["/tmp/a.png"])).toEqual([
      { type: "localImage", path: "/tmp/a.png" }
    ]);
  });

  test("downloads image attachments into the configured folder", async () => {
    const attachmentDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-discord-attachments-"));
    const payload = Buffer.from("image-bytes");
    const fetchImpl = async () => ({
      ok: true,
      arrayBuffer: async () => payload
    });

    const result = await downloadDiscordImageAttachments({
      id: "message-1",
      channelId: "channel-1",
      attachments: new Map([[
        "attachment-1",
        {
          id: "attachment-1",
          name: "Screenshot.PNG",
          contentType: "image/png",
          size: payload.length,
          url: "https://cdn.discordapp.test/image.png"
        }
      ]])
    }, {
      attachmentDir,
      maxImageAttachmentBytes: 1024,
      maxImageAttachments: 4
    }, fetchImpl);

    expect(result.skipped).toEqual([]);
    expect(result.saved).toHaveLength(1);
    expect(result.saved[0].path).toContain(path.join("channel-1", "message-1-attachment-1-screenshot.png"));
    await expect(fs.readFile(result.saved[0].path, "utf8")).resolves.toBe("image-bytes");

    await fs.rm(attachmentDir, { recursive: true, force: true });
  });

  test("skips oversized image attachments", async () => {
    const result = await downloadDiscordImageAttachments({
      id: "message-1",
      channelId: "channel-1",
      attachments: [{
        id: "attachment-1",
        name: "large.png",
        contentType: "image/png",
        size: 2048,
        url: "https://cdn.discordapp.test/large.png"
      }]
    }, {
      attachmentDir: "/tmp/codex-discord-unused",
      maxImageAttachmentBytes: 1024,
      maxImageAttachments: 4
    }, async () => {
      throw new Error("should not fetch oversized image");
    });

    expect(result.saved).toEqual([]);
    expect(result.skipped).toEqual([{
      name: "large.png",
      reason: "larger than 1024 bytes"
    }]);
  });
});
