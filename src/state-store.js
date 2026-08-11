"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = {
      channels: {},
      threads: {}
    };
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.state = {
        channels: parsed.channels || {},
        threads: parsed.threads || {}
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    return this.state;
  }

  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  getByChannel(channelId) {
    return this.state.channels[channelId] || null;
  }

  getByThread(threadId) {
    const channelId = this.state.threads[threadId];
    return channelId ? this.state.channels[channelId] || null : null;
  }

  listSessions() {
    return Object.values(this.state.channels);
  }

  async upsertSession(session) {
    const record = {
      ...session,
      updatedAt: new Date().toISOString()
    };

    this.state.channels[record.channelId] = record;
    this.state.threads[record.threadId] = record.channelId;
    await this.save();
    return record;
  }

  async updateSessionByThread(threadId, patch) {
    const existing = this.getByThread(threadId);
    if (!existing) {
      return null;
    }

    const record = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString()
    };

    this.state.channels[record.channelId] = record;
    this.state.threads[record.threadId] = record.channelId;
    await this.save();
    return record;
  }

  async replaceThreadForChannel(channelId, nextThreadId, patch = {}) {
    const existing = this.getByChannel(channelId);
    if (!existing) {
      return null;
    }

    delete this.state.threads[existing.threadId];
    const record = {
      ...existing,
      ...patch,
      channelId,
      threadId: nextThreadId,
      updatedAt: new Date().toISOString()
    };

    this.state.channels[channelId] = record;
    this.state.threads[nextThreadId] = channelId;
    await this.save();
    return record;
  }

  async deleteSessionByChannel(channelId) {
    const existing = this.getByChannel(channelId);
    if (!existing) {
      return null;
    }

    delete this.state.channels[channelId];
    delete this.state.threads[existing.threadId];
    await this.save();
    return existing;
  }
}

module.exports = {
  StateStore
};
