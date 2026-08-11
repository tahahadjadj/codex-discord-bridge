"use strict";

const {
  categoryNameForProject,
  collectAgentMessages,
  channelNameForSession,
  getNewTerminalTurns,
  getSyncableTerminalTurns,
  hasInProgressAfter,
  isThreadRecentlyUpdated,
  isTurnReadyForSync,
  seedLastSeenTurnId,
  sessionIdentityKey,
  sessionIdentityKeyForThread,
  shouldSkipUnchangedThread,
  shortThreadId,
  titleFromThread
} = require("../src/thread-sync");

describe("thread sync helpers", () => {
  test("uses safe thread titles without preview text", () => {
    expect(titleFromThread({ name: "Fix Login", preview: "secret" })).toBe("Fix Login");
    expect(titleFromThread({ cwd: "/tmp/my-project", preview: "secret" })).toBe("my-project");
  });

  test("shortens thread IDs for channel names", () => {
    expect(shortThreadId("019dbe91-f6ef-7693-867d-7aa2d8300221")).toBe("019dbe91");
  });

  test("builds channel names with short thread IDs", () => {
    expect(channelNameForSession("Fix Login", "019dbe91-f6ef-7693-867d-7aa2d8300221")).toBe("codex-Fix Login-019dbe91");
  });

  test("builds project category names from cwd", () => {
    expect(categoryNameForProject("/Users/me/WebstormProjects/front-integrations")).toBe("Codex - front-integrations");
    expect(categoryNameForProject("")).toBe("Codex - Unknown Project");
  });

  test("builds stable session identity keys from project and title", () => {
    expect(sessionIdentityKey(
      "End-to-End Sentry + Backend (PM2) Issue Triage and Resolution",
      "/Users/me/.codex/worktrees/e5b5/Prime-Automation-Fullstack"
    )).toBe("prime-automation-fullstack:end-to-end sentry + backend (pm2) issue triage and resolution");

    expect(sessionIdentityKeyForThread({
      name: "Fix API",
      cwd: "/Users/me/WebstormProjects/front-integrations"
    })).toBe("front-integrations:fix api");
  });

  test("seeds last seen turn without skipping active in-progress work", () => {
    expect(seedLastSeenTurnId([
      { id: "1", status: "completed" },
      { id: "2", status: "inProgress" }
    ])).toBe("1");
  });

  test("returns terminal turns after last seen", () => {
    expect(getNewTerminalTurns([
      { id: "1", status: "completed" },
      { id: "2", status: "inProgress" },
      { id: "3", status: "completed" }
    ], "1")).toEqual([{ id: "3", status: "completed" }]);
  });

  test("defers syncable terminal turns while later work is in progress", () => {
    const turns = [
      { id: "1", status: "completed" },
      { id: "2", status: "completed" },
      { id: "3", status: "inProgress" }
    ];

    expect(getNewTerminalTurns(turns, "1")).toEqual([{ id: "2", status: "completed" }]);
    expect(getSyncableTerminalTurns(turns, "1")).toEqual([]);
  });

  test("delays interrupted turns while the thread is still settling", () => {
    const turns = [
      { id: "1", status: "completed" },
      { id: "2", status: "interrupted", startedAt: 100 }
    ];

    expect(getNewTerminalTurns(turns, "1", {
      interruptedTurnGraceMs: 120000,
      nowMs: 160000,
      threadUpdatedAt: 100
    })).toEqual([]);

    expect(getNewTerminalTurns(turns, "1", {
      interruptedTurnGraceMs: 120000,
      nowMs: 240001,
      threadUpdatedAt: 100
    })).toEqual([turns[1]]);
  });

  test("treats completed interrupted turns as ready immediately", () => {
    expect(isTurnReadyForSync({
      id: "2",
      status: "interrupted",
      completedAt: 101
    }, {
      interruptedTurnGraceMs: 120000,
      nowMs: 102000,
      threadUpdatedAt: 101
    })).toBe(true);
  });

  test("detects in-progress turns after last seen", () => {
    expect(hasInProgressAfter([
      { id: "1", status: "completed" },
      { id: "2", status: "inProgress" }
    ], "1")).toBe(true);
  });

  test("skips active-session sync when the thread summary has not advanced", () => {
    expect(shouldSkipUnchangedThread(
      { updatedAt: 100 },
      { lastSeenThreadUpdatedAt: 100 }
    )).toBe(true);

    expect(shouldSkipUnchangedThread(
      { updatedAt: 101 },
      { lastSeenThreadUpdatedAt: 100 }
    )).toBe(false);
  });

  test("detects recently updated thread summaries", () => {
    expect(isThreadRecentlyUpdated({ updatedAt: 100 }, 150000, 60000)).toBe(true);
    expect(isThreadRecentlyUpdated({ updatedAt: 100 }, 170001, 60000)).toBe(false);
  });

  test("collects agent messages from a turn", () => {
    expect(collectAgentMessages({
      items: [
        { type: "userMessage", text: "hello" },
        { type: "agentMessage", text: "done" },
        { type: "agentMessage", content: [{ text: "from " }, { content: "parts" }] }
      ]
    })).toEqual(["done", "from parts"]);
  });
});
