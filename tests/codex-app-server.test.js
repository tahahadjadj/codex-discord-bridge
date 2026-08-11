"use strict";

const { CodexAppServer, normalizeTurnInput } = require("../src/codex-app-server");

describe("CodexAppServer", () => {
  test("normalizes text and structured turn input", () => {
    const structured = [{ type: "localImage", path: "/tmp/image.png" }];

    expect(normalizeTurnInput("hello")).toEqual([{ type: "text", text: "hello" }]);
    expect(normalizeTurnInput(structured)).toBe(structured);
  });

  test("maps app-server error notifications away from EventEmitter error", (done) => {
    const codex = new CodexAppServer();
    codex.on("serverError", (params) => {
      expect(params.error.message).toBe("failed");
      done();
    });

    codex.handleLine(JSON.stringify({
      method: "error",
      params: {
        error: {
          message: "failed"
        }
      }
    }));
  });

  test("passes model and reasoning effort through turn start", async () => {
    const codex = new CodexAppServer();
    codex.request = jest.fn().mockResolvedValue({ turn: { id: "turn-1" } });

    await codex.startTurn("thread-1", "hello", {
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      cwd: "/tmp/project"
    });

    expect(codex.request).toHaveBeenCalledWith("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "hello" }],
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      cwd: "/tmp/project"
    });
  });

  test("times out stuck requests and resets the connection", async () => {
    jest.useFakeTimers();
    const codex = new CodexAppServer({ requestTimeoutMs: 10 });
    const kill = jest.fn();
    codex.proc = {
      stdin: { write: jest.fn() },
      kill
    };
    codex.initialized = true;

    const pending = codex.request("thread/read", { threadId: "thread-1" }, { skipInitialize: true });
    jest.advanceTimersByTime(11);

    await expect(pending).rejects.toThrow("codex app-server request timed out for thread/read");
    expect(kill).toHaveBeenCalled();
    expect(codex.proc).toBeNull();
    expect(codex.initialized).toBe(false);

    jest.useRealTimers();
  });
});
