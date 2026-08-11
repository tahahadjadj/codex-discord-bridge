"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { StateStore } = require("../src/state-store");

describe("StateStore", () => {
  test("replaces a channel mapping with a new thread id", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-state-store-"));
    const statePath = path.join(tempDir, "session-map.json");
    const store = new StateStore(statePath);

    await store.upsertSession({
      channelId: "channel-1",
      threadId: "thread-old",
      title: "Example",
      cwd: "/tmp/example"
    });

    const replaced = await store.replaceThreadForChannel("channel-1", "thread-new", {
      lastSeenTurnId: null
    });

    expect(replaced.threadId).toBe("thread-new");
    expect(store.getByThread("thread-old")).toBeNull();
    expect(store.getByThread("thread-new")).toMatchObject({
      channelId: "channel-1",
      threadId: "thread-new",
      title: "Example"
    });

    const saved = JSON.parse(await fs.readFile(statePath, "utf8"));
    expect(saved.threads["thread-old"]).toBeUndefined();
    expect(saved.threads["thread-new"]).toBe("channel-1");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("deletes a channel mapping", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-state-store-"));
    const statePath = path.join(tempDir, "session-map.json");
    const store = new StateStore(statePath);

    await store.upsertSession({
      channelId: "channel-1",
      threadId: "thread-1",
      title: "Example",
      cwd: "/tmp/example"
    });

    const deleted = await store.deleteSessionByChannel("channel-1");
    expect(deleted.threadId).toBe("thread-1");
    expect(store.getByChannel("channel-1")).toBeNull();
    expect(store.getByThread("thread-1")).toBeNull();

    const saved = JSON.parse(await fs.readFile(statePath, "utf8"));
    expect(saved.channels["channel-1"]).toBeUndefined();
    expect(saved.threads["thread-1"]).toBeUndefined();

    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
