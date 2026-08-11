"use strict";

const { EventEmitter } = require("node:events");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

class CodexAppServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.command = options.command || "codex";
    this.args = options.args || ["app-server"];
    this.requestTimeoutMs = options.requestTimeoutMs || 45000;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.initialized = false;
    this.initializePromise = null;
  }

  start() {
    if (this.proc) {
      return;
    }

    this.proc = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"]
    });

    const stdout = readline.createInterface({ input: this.proc.stdout });
    stdout.on("line", (line) => this.handleLine(line));

    this.proc.stderr.on("data", (chunk) => {
      this.emit("stderr", chunk.toString("utf8"));
    });

    this.proc.on("exit", (code, signal) => {
      this.proc = null;
      this.initialized = false;
      this.initializePromise = null;
      this.emit("exit", { code, signal });
      this.rejectAllPending(new Error(`codex app-server exited with code ${code}`));
    });
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    if (this.initializePromise) {
      await this.initializePromise;
      return;
    }

    this.initializePromise = (async () => {
      this.start();
      await this.request("initialize", {
        clientInfo: {
          name: "local_discord_bridge",
          title: "Local Discord Codex Bridge",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true
        }
      }, { skipInitialize: true });
      this.sendNotification("initialized", {});
      this.initialized = true;
    })();

    try {
      await this.initializePromise;
    } finally {
      this.initializePromise = null;
    }
  }

  async request(method, params = {}, options = {}) {
    if (!this.proc) {
      this.start();
    }

    if (!options.skipInitialize && method !== "initialize") {
      await this.initialize();
    }

    const id = this.nextId;
    this.nextId += 1;
    const payload = { method, id, params };

    const timeoutMs = options.timeoutMs || this.requestTimeoutMs;
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`codex app-server request timed out for ${method}`);
        this.recoverFromStalledConnection(error);
        reject(error);
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timeout
      });
    });

    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  sendNotification(method, params = {}) {
    if (!this.proc) {
      this.start();
    }

    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async startThread(params) {
    const response = await this.request("thread/start", params);
    return response.thread;
  }

  async resumeThread(threadId, params = {}) {
    const response = await this.request("thread/resume", {
      threadId,
      ...params
    });
    return response.thread;
  }

  async listThreads(params = {}) {
    return this.request("thread/list", params);
  }

  async readThread(threadId, includeTurns = true) {
    const response = await this.request("thread/read", {
      threadId,
      includeTurns
    });
    return response.thread;
  }

  async setThreadName(threadId, name) {
    return this.request("thread/name/set", {
      threadId,
      name
    });
  }

  async startTurn(threadId, input, params = {}) {
    return this.request("turn/start", {
      threadId,
      input: normalizeTurnInput(input),
      ...params
    });
  }

  async steerTurn(threadId, input, expectedTurnId) {
    return this.request("turn/steer", {
      threadId,
      expectedTurnId,
      input: normalizeTurnInput(input)
    });
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit("stderr", `Could not parse app-server JSON: ${error.message}\n${line}`);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new Error(message.error.message || "Codex app-server request failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      this.emit("notification", message);
      if (message.method === "error") {
        this.emit("serverError", message.params || {});
        return;
      }
      this.emit(message.method, message.params || {});
    }
  }

  stop() {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.initialized = false;
    this.initializePromise = null;
    this.rejectAllPending(new Error("codex app-server stopped"));
  }

  rejectAllPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  recoverFromStalledConnection(error) {
    this.initialized = false;
    this.initializePromise = null;
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.rejectAllPending(error);
  }
}

function normalizeTurnInput(input) {
  if (Array.isArray(input)) {
    return input;
  }

  return [{ type: "text", text: String(input || "") }];
}

module.exports = {
  CodexAppServer,
  normalizeTurnInput
};
