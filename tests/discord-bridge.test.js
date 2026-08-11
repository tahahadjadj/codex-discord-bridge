"use strict";

const {
  agentMessageStreamKey,
  compareActivityEntries,
  comparePruneCandidates,
  discordChannelActivityTimeMs,
  DiscordCodexBridge,
  extractAgentMessageText,
  formatImageCount,
  formatSkippedAttachmentMessage,
  formatTurnFinishedPing,
  formatTurnStatusMessage,
  getUnsentAgentText,
  notificationUserIds,
  sessionSortTimeMs,
  truncateStatusDetail
} = require("../src/discord-bridge");

describe("discord bridge helpers", () => {
  test("extracts agent text from direct text field", () => {
    expect(extractAgentMessageText({ text: "done" })).toBe("done");
  });

  test("extracts agent text from content parts", () => {
    expect(extractAgentMessageText({
      content: [{ text: "hello " }, { content: "world" }]
    })).toBe("hello world");
  });

  test("keys agent streams by item when present", () => {
    expect(agentMessageStreamKey({ itemId: "item-1" }, {}, "thread-1"))
      .toBe("thread-1:item-1");
    expect(agentMessageStreamKey({}, {}, "thread-1"))
      .toBe("thread-1:agent");
  });

  test("only sends completed text that was not already streamed", () => {
    expect(getUnsentAgentText("hello world", "hello ")).toBe("world");
    expect(getUnsentAgentText("hello world", "hello world")).toBe("");
    expect(getUnsentAgentText("hello world", "")).toBe("hello world");
  });

  test("formats turn status with interruption context", () => {
    expect(formatTurnStatusMessage({ status: "completed" }, { hadAgentOutput: true })).toBeNull();
    expect(formatTurnStatusMessage({
      status: "interrupted",
      items: [{ type: "userMessage", content: [{ text: "is stripe working?" }] }]
    }, { hadAgentOutput: false })).toBe([
      "Codex turn interrupted before any assistant response was recorded.",
      "Request: is stripe working?",
      "Reason: no error was recorded by Codex."
    ].join("\n"));
    expect(formatTurnStatusMessage({ status: "failed", error: { message: "boom" } }, {}))
      .toBe("Codex turn failed.\nReason: boom");
  });

  test("truncates long status details", () => {
    expect(truncateStatusDetail("a".repeat(300))).toHaveLength(240);
  });

  test("formats image forwarding status", () => {
    expect(formatImageCount(0)).toBe("");
    expect(formatImageCount(1)).toBe(" with 1 image");
    expect(formatImageCount(2)).toBe(" with 2 images");
  });

  test("formats skipped attachment details", () => {
    expect(formatSkippedAttachmentMessage([{ name: "big.png", reason: "too large" }]))
      .toBe("Skipped unsupported image attachment(s):\n- big.png: too large");
  });

  test("prefers the last interacting Discord user for finish pings", () => {
    expect(notificationUserIds({
      lastInteractingUserId: "user-1"
    }, {
      notifyUserIds: ["user-1", "user-2"]
    })).toEqual(["user-1", "user-2"]);
  });

  test("formats finish ping mentions", () => {
    expect(formatTurnFinishedPing(["user-1"], "completed"))
      .toBe("<@user-1> Codex turn completed.");
    expect(formatTurnFinishedPing(["user-1"], "failed"))
      .toBe("<@user-1> Codex turn failed.");
  });

  test("sorts sessions by Codex thread update time first", () => {
    expect(sessionSortTimeMs({ lastSeenThreadUpdatedAt: 10, updatedAt: "2026-05-01T00:00:00.000Z" }))
      .toBe(10000);
    expect(sessionSortTimeMs({ updatedAt: "2026-05-01T00:00:00.000Z" }))
      .toBe(Date.parse("2026-05-01T00:00:00.000Z"));
    expect(sessionSortTimeMs({})).toBe(0);
  });

  test("uses the newest Discord message as the channel activity time", () => {
    const messageTimestamp = Date.parse("2026-07-09T20:00:00.000Z");
    const lastMessageId = ((BigInt(messageTimestamp) - 1420070400000n) << 22n).toString();

    expect(discordChannelActivityTimeMs({ lastMessageId }, {
      lastSeenThreadUpdatedAt: messageTimestamp / 1000 - 60
    })).toBe(messageTimestamp);
    expect([
      { activityAt: 10 },
      { activityAt: 30 },
      { activityAt: 20 }
    ].sort(compareActivityEntries)).toEqual([
      { activityAt: 30 },
      { activityAt: 20 },
      { activityAt: 10 }
    ]);
  });

  test("prefers pruning old mirrors in the target category", () => {
    const candidates = [
      { parentId: "other", session: { lastSeenThreadUpdatedAt: 1 } },
      { parentId: "target", session: { lastSeenThreadUpdatedAt: 5 } },
      { parentId: "target", session: { lastSeenThreadUpdatedAt: 3 } }
    ];

    expect(candidates.sort((a, b) => comparePruneCandidates(a, b, "target")))
      .toEqual([
        { parentId: "target", session: { lastSeenThreadUpdatedAt: 3 } },
        { parentId: "target", session: { lastSeenThreadUpdatedAt: 5 } },
        { parentId: "other", session: { lastSeenThreadUpdatedAt: 1 } }
      ]);
  });

  test("finds a reusable session with the same project and title", () => {
    const bridge = new DiscordCodexBridge({
      config: {},
      codex: {},
      stateStore: {
        listSessions: () => [
          {
            channelId: "old-channel",
            threadId: "old-thread",
            title: "End-to-End Sentry + Backend (PM2) Issue Triage and Resolution",
            cwd: "/Users/me/.codex/worktrees/a3cf/Prime-Automation-Fullstack",
            lastSeenThreadUpdatedAt: 10
          },
          {
            channelId: "active-channel",
            threadId: "active-thread",
            title: "End-to-End Sentry + Backend (PM2) Issue Triage and Resolution",
            cwd: "/Users/me/.codex/worktrees/b84d/Prime-Automation-Fullstack",
            lastSeenThreadUpdatedAt: 20
          }
        ]
      }
    });

    expect(bridge.findReusableSessionForThread({
      id: "new-thread",
      name: "End-to-End Sentry + Backend (PM2) Issue Triage and Resolution",
      cwd: "/Users/me/.codex/worktrees/e5b5/Prime-Automation-Fullstack"
    }, new Set(["active-thread"]))).toMatchObject({
      channelId: "old-channel",
      threadId: "old-thread"
    });
    bridge.client.destroy();
  });

  test("promotes a busy session once per reorder cooldown", async () => {
    jest.useFakeTimers();
    const bridge = new DiscordCodexBridge({
      config: { channelReorderDebounceMs: 2000 },
      codex: {},
      stateStore: {}
    });
    bridge.promoteSessionChannel = jest.fn().mockResolvedValue();
    const channel = { id: "channel-1" };
    const session = { threadId: "thread-1" };

    bridge.scheduleSessionPromotion(channel, session);
    bridge.scheduleSessionPromotion(channel, session);
    await bridge.channelReorderQueue;
    expect(bridge.promoteSessionChannel).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(2000);
    bridge.scheduleSessionPromotion(channel, session);
    await bridge.channelReorderQueue;
    expect(bridge.promoteSessionChannel).toHaveBeenCalledTimes(2);

    bridge.client.destroy();
    jest.useRealTimers();
  });

  test("sorts mirrored channels and categories by recent activity", async () => {
    const bridge = new DiscordCodexBridge({
      config: {},
      codex: {},
      stateStore: {
        listSessions: () => [
          { channelId: "channel-old", lastSeenThreadUpdatedAt: 10 },
          { channelId: "channel-new", lastSeenThreadUpdatedAt: 30 },
          { channelId: "channel-mid", lastSeenThreadUpdatedAt: 20 }
        ]
      }
    });
    const channels = new Map([
      ["category-a", { id: "category-a" }],
      ["category-b", { id: "category-b" }],
      ["channel-old", { id: "channel-old", parentId: "category-a", lastMessageId: null }],
      ["channel-new", { id: "channel-new", parentId: "category-a", lastMessageId: null }],
      ["channel-mid", { id: "channel-mid", parentId: "category-b", lastMessageId: null }]
    ]);
    bridge.guild = {
      channels: {
        cache: channels,
        fetch: jest.fn().mockResolvedValue(channels),
        setPositions: jest.fn().mockResolvedValue()
      }
    };

    await bridge.sortDiscordLayoutByRecency();

    expect(bridge.guild.channels.setPositions).toHaveBeenCalledWith([
      { channel: "category-a", position: 0 },
      { channel: "channel-new", position: 0 },
      { channel: "channel-old", position: 1 },
      { channel: "category-b", position: 1 },
      { channel: "channel-mid", position: 0 }
    ]);
    bridge.client.destroy();
  });

  test("delays finish pings until the thread is quiet", async () => {
    jest.useFakeTimers();
    const bridge = new DiscordCodexBridge({
      config: {
        completionPingQuietMs: 10000,
        notifyUserIds: ["user-1"]
      },
      codex: {},
      stateStore: {}
    });
    const channel = { send: jest.fn().mockResolvedValue({}) };

    bridge.scheduleTurnFinishedPing(channel, { threadId: "thread-1" }, "completed");
    await jest.advanceTimersByTimeAsync(9999);
    expect(channel.send).not.toHaveBeenCalled();

    bridge.recordThreadActivity("thread-1");
    await jest.advanceTimersByTimeAsync(9999);
    expect(channel.send).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(channel.send).toHaveBeenCalledWith({
      content: "<@user-1> Codex turn completed.",
      allowedMentions: { users: ["user-1"] }
    });
    bridge.client.destroy();
    jest.useRealTimers();
  });
});
