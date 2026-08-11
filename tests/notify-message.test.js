"use strict";

const { formatNotifyMessage } = require("../src/notify-message");

describe("notify message", () => {
  test("formats generic Codex notification payloads", () => {
    expect(formatNotifyMessage({
      type: "agent-turn-complete",
      title: "Work finished",
      status: "completed",
      cwd: "/tmp/project"
    })).toContain("agent-turn-complete");
  });
});
