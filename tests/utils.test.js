"use strict";

const {
  chunkDiscordMessage,
  parseControlCommand,
  slugifyChannelName,
  truncateForTopic
} = require("../src/utils");

describe("utils", () => {
  test("slugifies Discord channel names", () => {
    expect(slugifyChannelName("Codex: Fix API/Auth Flow!")).toBe("codex-fix-api-auth-flow");
    expect(slugifyChannelName("")).toBe("codex-session");
  });

  test("chunks long Discord messages", () => {
    const chunks = chunkDiscordMessage(`hello\n${"a".repeat(2100)}`, 1000);
    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.length <= 1000)).toBe(true);
  });

  test("parses control commands", () => {
    expect(parseControlCommand("!codex new build discord bridge")).toEqual({
      command: "new",
      title: "build discord bridge"
    });
    expect(parseControlCommand("hello")).toBeNull();
  });

  test("truncates channel topics", () => {
    expect(truncateForTopic("a".repeat(20), 10)).toBe("aaaaaaa...");
  });
});
