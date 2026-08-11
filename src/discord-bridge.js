"use strict";

const {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits
} = require("discord.js");
const {
  buildCodexTurnInput,
  downloadDiscordImageAttachments
} = require("./discord-attachments");
const { chunkDiscordMessage, parseControlCommand, slugifyChannelName, truncateForTopic } = require("./utils");
const {
  categoryNameForProject,
  collectAgentMessages,
  channelNameForSession,
  getSyncableTerminalTurns,
  hasInProgressAfter,
  isThreadRecentlyUpdated,
  seedLastSeenTurnId,
  sessionIdentityKey,
  sessionIdentityKeyForThread,
  shouldSkipUnchangedThread,
  shortThreadId,
  titleFromThread
} = require("./thread-sync");

class DiscordCodexBridge {
  constructor({ config, codex, stateStore }) {
    this.config = config;
    this.codex = codex;
    this.stateStore = stateStore;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ]
    });
    this.guild = null;
    this.category = null;
    this.controlChannel = null;
    this.activeTurns = new Map();
    this.streamBuffers = new Map();
    this.threadAgentOutput = new Map();
    this.threadActivityAt = new Map();
    this.pendingFinishPings = new Map();
    this.threadSyncBackoffUntil = new Map();
    this.channelPromotionCooldowns = new Map();
    this.channelReorderQueue = Promise.resolve();
    this.syncTimer = null;
    this.syncRunning = false;
  }

  async start() {
    await this.stateStore.load();
    await this.codex.initialize();
    this.bindCodexEvents();
    this.bindDiscordEvents();
    await this.client.login(this.config.discordToken);
  }

  bindDiscordEvents() {
    this.client.once(Events.ClientReady, async () => {
      this.guild = await this.client.guilds.fetch(this.config.guildId);
      await this.guild.channels.fetch();
      await this.ensureDiscordLayout();
      console.log(`Discord Codex bridge ready in guild ${this.guild.id}`);
      await this.controlChannel.send(
        [
          "Codex bridge is online.",
          "Use `!codex new <session name>` here to create a mirrored session channel.",
          "Send messages inside a session channel to start or steer Codex.",
          "Recently active local Codex sessions are mirrored automatically."
        ].join("\n")
      );
      await this.startActiveSessionSync();
    });

    this.client.on(Events.MessageCreate, async (message) => {
      if (!message.guild || message.guild.id !== this.config.guildId) {
        return;
      }

      const session = this.stateStore.getByChannel(message.channelId);
      if (session) {
        this.scheduleSessionPromotion(message.channel, session);
      }

      if (message.author.bot) {
        return;
      }

      if (!this.isAuthorized(message.author.id)) {
        return;
      }

      try {
        if (this.controlChannel && message.channelId === this.controlChannel.id) {
          await this.handleControlMessage(message);
          return;
        }

        if (session) {
          await this.handleSessionMessage(message, session);
        }
      } catch (error) {
        await message.reply(`Codex bridge error: ${error.message}`);
      }
    });
  }

  bindCodexEvents() {
    this.codex.on("stderr", (line) => {
      process.stderr.write(line);
    });

    this.codex.on("serverError", async (params) => {
      const threadId = params.threadId;
      const message = params.error?.message || params.error?.additionalDetails || "Codex app-server error";
      if (params.willRetry && message.startsWith("Reconnecting...")) {
        return;
      }
      if (!threadId) {
        console.error(message);
        return;
      }

      const session = this.stateStore.getByThread(threadId);
      if (!session) {
        console.error(message);
        return;
      }

      const channel = await this.fetchChannel(session.channelId);
      if (channel) {
        await channel.send(`Codex error: ${message}`);
      }
    });

    this.codex.on("turn/started", (params) => {
      if (params.threadId && params.turn?.id) {
        this.recordThreadActivity(params.threadId);
        this.cancelTurnFinishedPing(params.threadId);
        this.activeTurns.set(params.threadId, params.turn.id);
        this.threadAgentOutput.set(params.threadId, false);
      }
    });

    this.codex.on("item/agentMessage/delta", async (params) => {
      const threadId = params.threadId || params.thread?.id;
      const delta = params.delta || params.text || params.content || "";
      if (!threadId || !delta) {
        return;
      }

      this.recordThreadActivity(threadId);
      const streamKey = agentMessageStreamKey(params, params.item, threadId);
      await this.appendStreamText(streamKey, threadId, delta);
    });

    this.codex.on("item/completed", async (params) => {
      const item = params.item || {};
      if (item.type !== "agentMessage") {
        return;
      }

      const threadId = params.threadId || item.threadId;
      const text = extractAgentMessageText(item);
      if (threadId && text) {
        this.recordThreadActivity(threadId);
        const streamKey = this.findStreamBufferKey(params, item, threadId);
        const streamState = this.streamBuffers.get(streamKey);

        if (streamState) {
          await this.flushStreamBuffer(streamKey);
          const sentText = this.streamBuffers.get(streamKey)?.sentText || "";
          const unsentText = getUnsentAgentText(text, sentText);
          if (unsentText) {
            await this.appendStreamText(streamKey, threadId, unsentText, true);
          }
          this.removeStreamBuffer(streamKey);
        } else {
          await this.sendTextToThreadChannel(threadId, text);
        }
      }
    });

    this.codex.on("turn/completed", async (params) => {
      const threadId = params.threadId || params.turn?.threadId;
      if (!threadId) {
        return;
      }

      this.activeTurns.delete(threadId);
      await this.flushThreadStreamBuffers(threadId);
      this.recordThreadActivity(threadId);

      const session = this.stateStore.getByThread(threadId);
      if (!session) {
        return;
      }

      const channel = await this.fetchChannel(session.channelId);
      if (!channel) {
        return;
      }

      const status = params.turn?.status || params.status || "completed";
      const hadAgentOutput = this.threadAgentOutput.get(threadId) === true;
      this.threadAgentOutput.delete(threadId);
      const statusMessage = formatTurnStatusMessage({
        ...(params.turn || {}),
        status
      }, { hadAgentOutput });
      if (statusMessage) {
        await channel.send(statusMessage);
        this.recordThreadActivity(threadId);
      }
      this.scheduleTurnFinishedPing(channel, session, status);
      await this.updateSessionTopic(channel, session, `Idle. Last turn ${status}.`);
      await this.stateStore.updateSessionByThread(threadId, {
        lastSeenTurnId: params.turn?.id || session.lastSeenTurnId,
        lastSeenTurnStatus: status,
        lastSeenThreadUpdatedAt: Math.floor(Date.now() / 1000)
      });
    });
  }

  isAuthorized(userId) {
    return this.config.ownerUserIds.length === 0 || this.config.ownerUserIds.includes(userId);
  }

  async ensureDiscordLayout() {
    this.category = this.guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildCategory && channel.name === this.config.categoryName
    );

    if (!this.category) {
      this.category = await this.guild.channels.create({
        name: this.config.categoryName,
        type: ChannelType.GuildCategory
      });
    }

    this.controlChannel = this.guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildText && channel.name === this.config.controlChannelName
    );

    if (!this.controlChannel) {
      this.controlChannel = await this.guild.channels.create({
        name: this.config.controlChannelName,
        type: ChannelType.GuildText,
        parent: this.category.id,
        topic: "Create Codex sessions with !codex new <session name>."
      });
    }
  }

  async handleControlMessage(message) {
    const command = parseControlCommand(message.content);
    if (!command) {
      return;
    }

    if (command.command === "help") {
      await message.reply("Use `!codex new <session name>` to create a mirrored Codex session channel.");
      return;
    }

    if (command.command !== "new") {
      await message.reply("Unknown command. Use `!codex new <session name>`.");
      return;
    }

    const title = command.title || `Codex ${new Date().toISOString().slice(0, 16)}`;
    const session = await this.createSession(title);
    await message.reply(`Created <#${session.channelId}> for Codex thread ${session.threadId}.`);
  }

  async createSession(title) {
    const thread = await this.codex.startThread({
      model: this.config.codexModel,
      reasoningEffort: this.config.codexReasoningEffort,
      cwd: this.config.codexCwd,
      approvalPolicy: this.config.codexApprovalPolicy,
      sandbox: this.config.codexSandbox,
      serviceName: "local_discord_bridge"
    });

    await this.codex.setThreadName(thread.id, title);
    const projectCategory = await this.ensureProjectCategory(this.config.codexCwd);
    await this.ensureChannelCapacity({
      neededChannels: 1,
      keepThreadIds: [thread.id],
      preferredParentId: projectCategory.id
    });

    const channel = await this.guild.channels.create({
      name: slugifyChannelName(channelNameForSession(title, thread.id)),
      type: ChannelType.GuildText,
      parent: projectCategory.id,
      topic: truncateForTopic(`Codex thread ${thread.id}. Status: idle. CWD: ${this.config.codexCwd}`)
    });

    const session = await this.stateStore.upsertSession({
      channelId: channel.id,
      threadId: thread.id,
      title,
      cwd: this.config.codexCwd,
      createdBy: "discord",
      lastSeenTurnId: null
    });

    await channel.send([
      `Mirroring Codex thread ${thread.id}.`,
      "Send a message here to start a Codex turn.",
      "If Codex is already working, your message will steer the active turn."
    ].join("\n"));

    return session;
  }

  async startActiveSessionSync() {
    if (!this.config.discoverActiveSessions) {
      return;
    }

    await this.runSyncSafely();
    this.normalizeKnownSessionChannels()
      .then(() => this.sortDiscordLayoutByRecency())
      .catch((error) => {
        console.error(`Known Codex session normalization failed: ${error.message}`);
      });
    this.syncTimer = setInterval(() => {
      this.runSyncSafely();
    }, this.config.sessionSyncIntervalMs);
  }

  async normalizeKnownSessionChannels() {
    for (const session of this.stateStore.listSessions()) {
      try {
        const channel = await this.fetchChannel(session.channelId);
        if (channel) {
          await this.ensureSessionProjectParent(channel, session.cwd);
          await this.updateSessionTopic(channel, session, "Mapped.");
        }
      } catch (error) {
        console.error(`Could not normalize session ${session.threadId}: ${error.message}`);
      }
    }
  }

  async runSyncSafely() {
    try {
      await this.syncActiveSessions();
    } catch (error) {
      console.error(`Active Codex session sync failed: ${error.message}`);
    }
  }

  async syncActiveSessions() {
    if (this.syncRunning) {
      return;
    }

    this.syncRunning = true;
    try {
      const threads = await this.listRecentlyActiveThreads();
      const activeThreadIds = new Set(threads.map((thread) => thread.id));
      console.log(`Syncing ${threads.length} active Codex threads`);
      for (const thread of threads) {
        const backoffUntil = this.threadSyncBackoffUntil.get(thread.id) || 0;
        if (Date.now() < backoffUntil) {
          console.log(`Skipping Codex thread ${thread.id}; sync backoff active`);
          continue;
        }

        try {
          console.log(`Syncing Codex thread ${thread.id}`);
          await withTimeout(async () => {
            const session = this.stateStore.getByThread(thread.id) ||
              await this.ensureThreadChannel(thread, activeThreadIds);
            await this.syncThreadUpdates(thread.id, session, thread);
          }, 60000, `Timed out syncing thread ${thread.id}`);
          this.threadSyncBackoffUntil.delete(thread.id);
        } catch (error) {
          this.threadSyncBackoffUntil.set(thread.id, Date.now() + this.config.threadSyncBackoffMs);
          console.error(`Could not sync thread ${thread.id}: ${error.message}`);
        }
      }
    } finally {
      this.syncRunning = false;
    }
  }

  async listRecentlyActiveThreads() {
    const response = await this.codex.listThreads({
      archived: false,
      limit: this.config.sessionSyncLimit,
      sortKey: "updated_at"
    });
    const cutoffSeconds = Math.floor(Date.now() / 1000) - (this.config.activeSessionMaxAgeHours * 60 * 60);

    return (response.data || [])
      .filter((thread) => !thread.ephemeral)
      .filter((thread) => !thread.updatedAt || thread.updatedAt >= cutoffSeconds)
      .slice(0, this.config.sessionSyncLimit);
  }

  async ensureThreadChannel(thread, activeThreadIds = new Set()) {
    const existing = this.stateStore.getByThread(thread.id);
    if (existing) {
      const existingChannel = await this.fetchChannel(existing.channelId);
      if (existingChannel) {
        await this.ensureSessionProjectParent(existingChannel, existing.cwd || thread.cwd);
        return existing;
      }
    }

    const reusable = this.findReusableSessionForThread(thread, activeThreadIds);
    if (reusable) {
      const reusableChannel = await this.fetchChannel(reusable.channelId);
      if (reusableChannel) {
        const title = titleFromThread(thread);
        const replacementSession = await this.stateStore.replaceThreadForChannel(reusable.channelId, thread.id, {
          title,
          cwd: thread.cwd || reusable.cwd,
          createdBy: reusable.createdBy || "discovery",
          source: thread.source || reusable.source,
          lastSeenTurnId: null,
          lastSeenTurnStatus: null,
          historyBackfillDisabled: true,
          lastSeenThreadUpdatedAt: thread.updatedAt || null
        });
        await this.ensureSessionProjectParent(reusableChannel, replacementSession.cwd);
        await this.updateSessionChannelName(reusableChannel, title, thread.id);
        await this.updateSessionTopic(reusableChannel, replacementSession, `Mapped. Reused previous thread ${shortThreadId(reusable.threadId)}.`);
        await reusableChannel.send([
          `Reusing this Discord channel for Codex thread ${thread.id}.`,
          `Previous mapped thread: ${reusable.threadId}.`,
          "Historical prompt content is intentionally not backfilled."
        ].join("\n"));
        console.log(`Reused Discord channel ${reusable.channelId} for Codex thread ${thread.id}`);
        return replacementSession;
      }
    }

    const hydratedThread = await this.codex.readThread(thread.id, true);
    const title = titleFromThread(hydratedThread);
    const projectCategory = await this.ensureProjectCategory(hydratedThread.cwd);
    await this.ensureChannelCapacity({
      neededChannels: 1,
      keepThreadIds: [thread.id],
      preferredParentId: projectCategory.id
    });
    const channel = await this.guild.channels.create({
      name: slugifyChannelName(channelNameForSession(title, thread.id)),
      type: ChannelType.GuildText,
      parent: projectCategory.id,
      topic: truncateForTopic(`Codex thread ${thread.id}. Status: ${this.statusText(thread)} CWD: ${hydratedThread.cwd}`)
    });

    const session = await this.stateStore.upsertSession({
      channelId: channel.id,
      threadId: thread.id,
      title,
      cwd: hydratedThread.cwd,
      createdBy: "discovery",
      source: hydratedThread.source,
      lastSeenTurnId: seedLastSeenTurnId(hydratedThread.turns || []),
      lastSeenThreadUpdatedAt: hydratedThread.updatedAt
    });

    await channel.send([
      `Mirroring active Codex thread ${thread.id}.`,
      "Future Codex updates for this session will be posted here.",
      "Historical prompt content is intentionally not backfilled."
    ].join("\n"));

    return session;
  }

  findReusableSessionForThread(thread, activeThreadIds = new Set()) {
    const key = sessionIdentityKeyForThread(thread);
    return this.stateStore.listSessions()
      .filter((session) => session.threadId !== thread.id)
      .filter((session) => !activeThreadIds.has(session.threadId))
      .filter((session) => sessionIdentityKey(session.title, session.cwd) === key)
      .sort((a, b) => sessionSortTimeMs(b) - sessionSortTimeMs(a))[0] || null;
  }

  async syncThreadUpdates(threadId, session, threadSummary = {}) {
    if (shouldSkipUnchangedThread(threadSummary, session)) {
      return;
    }

    if (session.historyBackfillDisabled && threadSummary.updatedAt) {
      await this.stateStore.updateSessionByThread(threadId, {
        lastSeenThreadUpdatedAt: threadSummary.updatedAt
      });
      return;
    }

    if (session.lastInteractingUserId && session.lastSeenTurnStatus === "completed" && threadSummary.updatedAt) {
      await this.stateStore.updateSessionByThread(threadId, {
        lastSeenThreadUpdatedAt: threadSummary.updatedAt
      });
      return;
    }

    const channel = await this.fetchChannel(session.channelId);
    if (!channel) {
      return;
    }

    if (isThreadRecentlyUpdated(threadSummary, Date.now(), this.config.threadSyncQuietMs)) {
      await this.updateSessionTopic(channel, session, "Running.");
      return;
    }

    const thread = await this.codex.readThread(threadId, true);
    const turns = thread.turns || [];

    if (!session.lastSeenTurnId) {
      const seededTurnId = seedLastSeenTurnId(turns);
      if (seededTurnId) {
        await this.stateStore.updateSessionByThread(threadId, {
          lastSeenTurnId: seededTurnId,
          lastSeenThreadUpdatedAt: thread.updatedAt
        });
      }
      return;
    }

    if (hasInProgressAfter(turns, session.lastSeenTurnId)) {
      await this.updateSessionTopic(channel, session, "Running.");
    }

    const newTurns = getSyncableTerminalTurns(turns, session.lastSeenTurnId, {
      interruptedTurnGraceMs: this.config.interruptedTurnGraceMs,
      nowMs: Date.now(),
      threadUpdatedAt: thread.updatedAt
    });
    for (const turn of newTurns) {
      const messages = collectAgentMessages(turn);
      for (const message of messages) {
        for (const chunk of chunkDiscordMessage(message, 1900)) {
          await channel.send(chunk);
          this.recordThreadActivity(threadId);
          console.log(`Posted Codex update for ${threadId} to Discord channel ${session.channelId}`);
        }
      }

      const statusMessage = formatTurnStatusMessage(turn, { hadAgentOutput: messages.length > 0 });
      if (statusMessage) {
        await channel.send(statusMessage);
        this.recordThreadActivity(threadId);
      }
      this.scheduleTurnFinishedPing(channel, session, turn.status);

      session = await this.stateStore.updateSessionByThread(threadId, {
        lastSeenTurnId: turn.id,
        lastSeenTurnStatus: turn.status,
        lastSeenThreadUpdatedAt: thread.updatedAt
      }) || session;
      await this.updateSessionTopic(channel, session, `Idle. Last turn ${turn.status}.`);
    }
  }

  statusText(thread) {
    if (thread.status?.type === "active") {
      return "Running.";
    }
    if (thread.status?.type === "idle") {
      return "Idle.";
    }
    if (thread.status?.type === "systemError") {
      return "System error.";
    }
    return "Not loaded.";
  }

  async handleSessionMessage(message, session) {
    const text = message.content.trim();
    console.log(
      `Received Discord message ${message.id} in channel ${message.channelId} for thread ${session.threadId}`
    );
    const attachmentResult = await downloadDiscordImageAttachments(message, this.config);
    const imagePaths = attachmentResult.saved.map((attachment) => attachment.path);
    const input = buildCodexTurnInput(text, imagePaths);

    if (attachmentResult.skipped.length > 0) {
      await message.channel.send(formatSkippedAttachmentMessage(attachmentResult.skipped));
    }

    if (input.length === 0) {
      return;
    }

    session = await this.stateStore.updateSessionByThread(session.threadId, {
      lastInteractingUserId: message.author.id
    }) || session;
    session = await this.ensureResumedSession(message.channel, session, message.id);

    await this.updateSessionTopic(message.channel, session, "Running.");
    if (message.channel.sendTyping) {
      await message.channel.sendTyping();
    }

    const activeTurnId = this.activeTurns.get(session.threadId);
    if (activeTurnId) {
      console.log(`Steering active Codex turn ${activeTurnId} from Discord message ${message.id}`);
      await this.codex.steerTurn(session.threadId, input, activeTurnId);
      await message.react("↪️");
      await message.channel.send(`Sent to the active Codex turn${formatImageCount(imagePaths.length)}. Streaming updates here as Codex responds.`);
      return;
    }

    console.log(`Starting a new Codex turn for thread ${session.threadId} from Discord message ${message.id}`);
    await this.codex.startTurn(session.threadId, input, {
      model: this.config.codexModel,
      reasoningEffort: this.config.codexReasoningEffort,
      cwd: session.cwd || this.config.codexCwd,
      approvalPolicy: this.config.codexApprovalPolicy
    });
    await message.react("✅");
    await message.channel.send(`Codex is working${formatImageCount(imagePaths.length)}. Streaming updates here as they arrive.`);
  }

  async ensureResumedSession(channel, session, messageId) {
    console.log(`Resuming Codex thread ${session.threadId} before processing Discord message ${messageId}`);
    try {
      await this.codex.resumeThread(session.threadId, {
        model: this.config.codexModel,
        reasoningEffort: this.config.codexReasoningEffort,
        cwd: session.cwd || this.config.codexCwd,
        approvalPolicy: this.config.codexApprovalPolicy,
        sandbox: this.config.codexSandbox
      });
      console.log(`Resume succeeded for thread ${session.threadId} from Discord message ${messageId}`);
      return session;
    } catch (error) {
      console.error(`Resume failed for thread ${session.threadId}: ${error.message}`);
      return this.replaceSessionThread(channel, session, error);
    }
  }

  async replaceSessionThread(channel, session, error) {
    const replacementThread = await this.codex.startThread({
      model: this.config.codexModel,
      reasoningEffort: this.config.codexReasoningEffort,
      cwd: session.cwd || this.config.codexCwd,
      approvalPolicy: this.config.codexApprovalPolicy,
      sandbox: this.config.codexSandbox,
      serviceName: "local_discord_bridge"
    });
    await this.codex.setThreadName(replacementThread.id, session.title);

    const replacementSession = await this.stateStore.replaceThreadForChannel(channel.id, replacementThread.id, {
      cwd: session.cwd || this.config.codexCwd,
      title: session.title,
      lastSeenTurnId: null,
      lastSeenTurnStatus: null,
      lastSeenThreadUpdatedAt: replacementThread.updatedAt || null
    });

    await this.updateSessionChannelName(channel, replacementSession.title, replacementSession.threadId);
    await this.updateSessionTopic(channel, replacementSession, "Idle. Recovered after resume failure.");
    await channel.send([
      `Codex session recovery: replaced thread ${session.threadId} with ${replacementSession.threadId}.`,
      `Reason: ${truncateStatusDetail(error.message)}`
    ].join("\n"));
    return replacementSession;
  }

  ensureStreamBuffer(streamKey, threadId) {
    let state = this.streamBuffers.get(streamKey);
    if (!state) {
      state = {
        threadId,
        buffer: "",
        sentText: "",
        timer: null,
        flushing: false
      };
      this.streamBuffers.set(streamKey, state);
    }

    state.threadId = threadId;
    return state;
  }

  async appendStreamText(streamKey, threadId, text, flushNow = false) {
    const state = this.ensureStreamBuffer(streamKey, threadId);
    state.buffer += text;

    if (flushNow || (state.buffer.length >= 1600 && !state.flushing)) {
      await this.flushStreamBuffer(streamKey);
      return;
    }

    this.scheduleStreamFlush(streamKey);
  }

  scheduleStreamFlush(streamKey) {
    const state = this.streamBuffers.get(streamKey);
    if (!state || state.timer) {
      return;
    }

    state.timer = setTimeout(() => {
      this.flushStreamBuffer(streamKey).catch((error) => {
        console.error(`Could not flush Codex stream ${streamKey}: ${error.message}`);
      });
    }, this.config.streamFlushIntervalMs);
  }

  async flushStreamBuffer(streamKey) {
    const state = this.streamBuffers.get(streamKey);
    if (!state || state.flushing) {
      return;
    }

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    const text = state.buffer;
    if (!text) {
      return;
    }

    state.buffer = "";
    state.flushing = true;
    try {
      await this.sendTextToThreadChannel(state.threadId, text);
      state.sentText += text;
    } catch (error) {
      state.buffer = text + state.buffer;
      throw error;
    } finally {
      state.flushing = false;
      if (state.buffer) {
        this.scheduleStreamFlush(streamKey);
      }
    }
  }

  async flushThreadStreamBuffers(threadId) {
    const streamKeys = [...this.streamBuffers.entries()]
      .filter(([, state]) => state.threadId === threadId)
      .map(([streamKey]) => streamKey);

    for (const streamKey of streamKeys) {
      await this.flushStreamBuffer(streamKey);
      const state = this.streamBuffers.get(streamKey);
      if (state && !state.buffer && !state.flushing) {
        this.removeStreamBuffer(streamKey);
      }
    }
  }

  removeStreamBuffer(streamKey) {
    const state = this.streamBuffers.get(streamKey);
    if (state?.timer) {
      clearTimeout(state.timer);
    }
    this.streamBuffers.delete(streamKey);
  }

  findStreamBufferKey(params, item, threadId) {
    const exactKey = agentMessageStreamKey(params, item, threadId);
    if (this.streamBuffers.has(exactKey)) {
      return exactKey;
    }

    const threadFallbackKey = `${threadId}:agent`;
    if (this.streamBuffers.has(threadFallbackKey)) {
      return threadFallbackKey;
    }

    const existing = [...this.streamBuffers.entries()]
      .find(([, state]) => state.threadId === threadId);
    return existing?.[0] || exactKey;
  }

  async sendTextToThreadChannel(threadId, text) {
    const session = this.stateStore.getByThread(threadId);
    if (!session) {
      return;
    }

    const channel = await this.fetchChannel(session.channelId);
    if (!channel) {
      return;
    }

    const chunks = chunkDiscordMessage(text, 1900);
    for (const chunk of chunks) {
      await channel.send(chunk);
      this.recordThreadActivity(threadId);
    }
    if (chunks.length > 0) {
      this.threadAgentOutput.set(threadId, true);
    }
  }

  recordThreadActivity(threadId, timestamp = Date.now()) {
    if (threadId) {
      this.threadActivityAt.set(threadId, timestamp);
      const session = this.stateStore.getByThread?.(threadId);
      const channel = session ? this.client.channels.cache.get(session.channelId) : null;
      if (session && channel) {
        this.scheduleSessionPromotion(channel, session);
      }
    }
  }

  scheduleSessionPromotion(channel, session) {
    if (!channel?.id || !session || this.channelPromotionCooldowns.has(channel.id)) {
      return;
    }

    const cooldown = setTimeout(() => {
      this.channelPromotionCooldowns.delete(channel.id);
    }, this.config.channelReorderDebounceMs);
    this.channelPromotionCooldowns.set(channel.id, cooldown);

    this.channelReorderQueue = this.channelReorderQueue
      .then(() => this.promoteSessionChannel(channel, session))
      .catch((error) => {
        console.error(`Could not promote Discord channel ${channel.id}: ${error.message}`);
      });
  }

  async promoteSessionChannel(channel, session) {
    const category = channel.parent || this.guild?.channels.cache.get(channel.parentId);
    if (category?.setPosition && category.position !== 0) {
      await category.setPosition(0, { reason: `Recent Codex activity in ${session.threadId}` });
    }
    if (channel.setPosition && channel.position !== 0) {
      await channel.setPosition(0, { reason: `Recent Codex activity in ${session.threadId}` });
    }
  }

  async sortDiscordLayoutByRecency() {
    await this.guild.channels.fetch();
    const groupedSessions = new Map();

    for (const session of this.stateStore.listSessions()) {
      const channel = this.guild.channels.cache.get(session.channelId);
      if (!channel?.parentId) {
        continue;
      }

      const activityAt = discordChannelActivityTimeMs(channel, session);
      const group = groupedSessions.get(channel.parentId) || [];
      group.push({ activityAt, channel });
      groupedSessions.set(channel.parentId, group);
    }

    const categoryGroups = [...groupedSessions.entries()]
      .map(([categoryId, entries]) => ({
        activityAt: Math.max(...entries.map((entry) => entry.activityAt)),
        category: this.guild.channels.cache.get(categoryId),
        entries: entries.sort(compareActivityEntries)
      }))
      .filter((group) => group.category)
      .sort(compareActivityEntries);

    const positions = [];
    categoryGroups.forEach((group, categoryPosition) => {
      positions.push({ channel: group.category.id, position: categoryPosition });
      group.entries.forEach((entry, channelPosition) => {
        positions.push({ channel: entry.channel.id, position: channelPosition });
      });
    });

    if (positions.length > 0) {
      await this.guild.channels.setPositions(positions);
      console.log(`Sorted ${positions.length} Discord categories and channels by recent activity`);
    }
  }

  cancelTurnFinishedPing(threadId) {
    const pending = this.pendingFinishPings.get(threadId);
    if (pending?.timer) {
      clearTimeout(pending.timer);
    }
    this.pendingFinishPings.delete(threadId);
  }

  scheduleTurnFinishedPing(channel, session, status = "completed") {
    const userIds = notificationUserIds(session, this.config);
    if (userIds.length === 0) {
      return;
    }

    const threadId = session.threadId;
    this.cancelTurnFinishedPing(threadId);
    this.recordThreadActivity(threadId);

    const pending = {
      channel,
      session,
      status,
      userIds,
      timer: null
    };
    this.pendingFinishPings.set(threadId, pending);
    this.armTurnFinishedPing(threadId);
  }

  armTurnFinishedPing(threadId) {
    const pending = this.pendingFinishPings.get(threadId);
    if (!pending) {
      return;
    }

    if (pending.timer) {
      clearTimeout(pending.timer);
    }

    const quietMs = this.config.completionPingQuietMs;
    const lastActivityAt = this.threadActivityAt.get(threadId) || Date.now();
    const waitMs = Math.max(quietMs - (Date.now() - lastActivityAt), 0);
    pending.timer = setTimeout(() => {
      this.maybeSendTurnFinishedPing(threadId).catch((error) => {
        console.error(`Could not send completion ping for ${threadId}: ${error.message}`);
      });
    }, waitMs);
  }

  async maybeSendTurnFinishedPing(threadId) {
    const pending = this.pendingFinishPings.get(threadId);
    if (!pending) {
      return;
    }

    if (this.activeTurns.has(threadId) || this.hasPendingStreamOutput(threadId)) {
      this.recordThreadActivity(threadId);
      this.armTurnFinishedPing(threadId);
      return;
    }

    const quietMs = this.config.completionPingQuietMs;
    const lastActivityAt = this.threadActivityAt.get(threadId) || Date.now();
    const quietForMs = Date.now() - lastActivityAt;
    if (quietForMs < quietMs) {
      this.armTurnFinishedPing(threadId);
      return;
    }

    this.pendingFinishPings.delete(threadId);
    await pending.channel.send({
      content: formatTurnFinishedPing(pending.userIds, pending.status),
      allowedMentions: { users: pending.userIds }
    });
  }

  hasPendingStreamOutput(threadId) {
    return [...this.streamBuffers.values()].some((state) => (
      state.threadId === threadId && (state.flushing || Boolean(state.buffer))
    ));
  }

  async fetchChannel(channelId) {
    try {
      return await this.client.channels.fetch(channelId);
    } catch (error) {
      console.error(`Could not fetch Discord channel ${channelId}: ${error.message}`);
      return null;
    }
  }

  async ensureChannelCapacity(options = {}) {
    await this.guild.channels.fetch();

    const neededChannels = options.neededChannels || 1;
    const keepThreadIds = new Set(options.keepThreadIds || []);
    const preferredParentId = options.preferredParentId || null;
    let totalChannels = this.guild.channels.cache.size;
    let mirroredChannels = this.stateStore.listSessions().length;

    while (
      mirroredChannels >= this.config.maxMirroredSessionChannels ||
      totalChannels + neededChannels > this.config.maxGuildChannels
    ) {
      const pruned = await this.pruneOldestMirrorChannel({ keepThreadIds, preferredParentId });
      if (!pruned) {
        throw new Error([
          "Discord channel capacity reached and no inactive mirrored session channel could be pruned.",
          `Current guild channels: ${totalChannels}.`,
          `Mirrored sessions: ${mirroredChannels}.`,
          `Configured limits: DISCORD_MAX_GUILD_CHANNELS=${this.config.maxGuildChannels},`,
          `DISCORD_MAX_MIRRORED_SESSION_CHANNELS=${this.config.maxMirroredSessionChannels}.`
        ].join(" "));
      }

      await this.guild.channels.fetch();
      totalChannels = this.guild.channels.cache.size;
      mirroredChannels = this.stateStore.listSessions().length;
    }
  }

  async pruneOldestMirrorChannel(options = {}) {
    const keepThreadIds = options.keepThreadIds || new Set();
    const preferredParentId = options.preferredParentId || null;
    const nowMs = Date.now();
    const minAgeMs = this.config.channelPruneMinAgeHours * 60 * 60 * 1000;
    const candidates = this.stateStore.listSessions()
      .filter((session) => !keepThreadIds.has(session.threadId))
      .filter((session) => !this.activeTurns.has(session.threadId))
      .map((session) => ({
        session,
        parentId: this.guild.channels.cache.get(session.channelId)?.parentId || null,
        ageMs: nowMs - sessionSortTimeMs(session)
      }))
      .filter(({ ageMs }) => ageMs >= minAgeMs)
      .sort((a, b) => comparePruneCandidates(a, b, preferredParentId));

    for (const { session } of candidates) {
      const channel = await this.fetchChannel(session.channelId);
      if (channel?.delete) {
        await channel.delete(`Pruned old Codex mirror for ${session.threadId} to stay under channel limits`);
      }
      await this.stateStore.deleteSessionByChannel(session.channelId);
      console.log(`Pruned old Codex mirror ${session.threadId} from Discord channel ${session.channelId}`);
      return session;
    }

    return null;
  }

  async ensureProjectCategory(cwd) {
    const name = categoryNameForProject(cwd);
    const existing = this.guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildCategory && channel.name === name
    );

    if (existing) {
      return existing;
    }

    return this.guild.channels.create({
      name,
      type: ChannelType.GuildCategory
    });
  }

  async ensureSessionProjectParent(channel, cwd) {
    if (!channel.setParent) {
      return;
    }

    const projectCategory = await this.ensureProjectCategory(cwd);
    if (channel.parentId !== projectCategory.id) {
      await channel.setParent(projectCategory.id, { lockPermissions: false });
    }
  }

  async updateSessionTopic(channel, session, status) {
    if (!channel.setTopic) {
      return;
    }

    const topic = truncateForTopic(`Codex thread ${session.threadId}. Status: ${status} CWD: ${session.cwd}`);
    if (channel.topic !== topic) {
      await channel.setTopic(topic);
    }
  }

  async updateSessionChannelName(channel, title, threadId) {
    if (!channel.setName) {
      return;
    }

    const expectedName = slugifyChannelName(channelNameForSession(title, threadId));
    if (channel.name !== expectedName) {
      await channel.setName(expectedName);
    }
  }
}

function extractAgentMessageText(item) {
  if (typeof item.text === "string") {
    return item.text;
  }

  if (typeof item.message === "string") {
    return item.message;
  }

  if (Array.isArray(item.content)) {
    return item.content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        return part.text || part.content || "";
      })
      .join("");
  }

  return "";
}

function agentMessageStreamKey(params = {}, item = {}, threadId = "unknown") {
  const itemId = params.itemId || params.item?.id || item?.id || params.id;
  return itemId ? `${threadId}:${itemId}` : `${threadId}:agent`;
}

function getUnsentAgentText(finalText, sentText) {
  const final = String(finalText || "");
  const sent = String(sentText || "");

  if (!final) {
    return "";
  }

  if (!sent) {
    return final;
  }

  if (final.startsWith(sent)) {
    return final.slice(sent.length);
  }

  if (sent.includes(final)) {
    return "";
  }

  return final;
}

function formatTurnStatusMessage(turn, options = {}) {
  const status = turn?.status || "completed";
  const hadAgentOutput = options.hadAgentOutput === true;

  if (status === "completed" && hadAgentOutput) {
    return null;
  }

  const lines = [];
  if (status === "completed") {
    lines.push("Codex turn completed, but no assistant response was recorded.");
  } else if (status === "interrupted") {
    lines.push(hadAgentOutput
      ? "Codex turn interrupted after partial output."
      : "Codex turn interrupted before any assistant response was recorded.");
  } else if (status === "failed") {
    lines.push("Codex turn failed.");
  } else {
    lines.push(`Codex turn ${status}.`);
  }

  const prompt = extractTurnPromptText(turn);
  if (prompt) {
    lines.push(`Request: ${truncateStatusDetail(prompt)}`);
  }

  const error = extractTurnErrorMessage(turn);
  if (error) {
    lines.push(`Reason: ${truncateStatusDetail(error)}`);
  } else if (status !== "completed") {
    lines.push("Reason: no error was recorded by Codex.");
  }

  return lines.join("\n");
}

function extractTurnPromptText(turn) {
  const userItem = (turn?.items || []).find((item) => item.type === "userMessage");
  if (!userItem) {
    return "";
  }

  if (typeof userItem.text === "string") {
    return userItem.text;
  }

  if (Array.isArray(userItem.content)) {
    return userItem.content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        return part.text || part.content || "";
      })
      .join("");
  }

  return "";
}

function extractTurnErrorMessage(turn) {
  const error = turn?.error;
  if (!error) {
    return "";
  }

  if (typeof error === "string") {
    return error;
  }

  return error.message || error.additionalDetails || error.code || JSON.stringify(error);
}

function truncateStatusDetail(text, limit = 240) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= limit) {
    return clean;
  }
  return `${clean.slice(0, limit - 3)}...`;
}

function formatImageCount(count) {
  if (count === 0) {
    return "";
  }
  return ` with ${count} image${count === 1 ? "" : "s"}`;
}

function formatSkippedAttachmentMessage(skipped) {
  const details = skipped
    .slice(0, 5)
    .map((attachment) => `- ${attachment.name}: ${attachment.reason}`)
    .join("\n");
  const suffix = skipped.length > 5 ? `\n- ${skipped.length - 5} more attachment(s) skipped` : "";
  return `Skipped unsupported image attachment(s):\n${details}${suffix}`;
}

function notificationUserIds(session = {}, config = {}) {
  const ids = [];
  if (session.lastInteractingUserId) {
    ids.push(session.lastInteractingUserId);
  }
  ids.push(...(config.notifyUserIds || []));

  return [...new Set(ids.filter(Boolean))];
}

function formatTurnFinishedPing(userIds, status = "completed") {
  const mentions = userIds.map((userId) => `<@${userId}>`).join(" ");
  const label = status === "completed" ? "completed" : status;
  return `${mentions} Codex turn ${label}.`;
}

function sessionSortTimeMs(session = {}) {
  if (Number.isFinite(Number(session.lastSeenThreadUpdatedAt)) && Number(session.lastSeenThreadUpdatedAt) > 0) {
    return Number(session.lastSeenThreadUpdatedAt) * 1000;
  }

  const updatedAtMs = Date.parse(session.updatedAt || "");
  if (Number.isFinite(updatedAtMs)) {
    return updatedAtMs;
  }

  return 0;
}

function discordChannelActivityTimeMs(channel = {}, session = {}) {
  let messageTimestamp = 0;
  try {
    if (channel.lastMessageId) {
      messageTimestamp = Number((BigInt(channel.lastMessageId) >> 22n) + 1420070400000n);
    }
  } catch {
    messageTimestamp = 0;
  }

  return Math.max(messageTimestamp, sessionSortTimeMs(session));
}

function compareActivityEntries(a, b) {
  return b.activityAt - a.activityAt;
}

function comparePruneCandidates(a, b, preferredParentId = null) {
  const aPreferred = preferredParentId && a.parentId === preferredParentId ? 0 : 1;
  const bPreferred = preferredParentId && b.parentId === preferredParentId ? 0 : 1;
  if (aPreferred !== bPreferred) {
    return aPreferred - bPreferred;
  }

  return sessionSortTimeMs(a.session) - sessionSortTimeMs(b.session);
}

module.exports = {
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
};

function withTimeout(task, timeoutMs, message) {
  let timer;
  return Promise.race([
    Promise.resolve().then(task),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}
