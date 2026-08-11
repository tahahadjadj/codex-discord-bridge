"use strict";

const path = require("node:path");

function shortThreadId(threadId) {
  return String(threadId || "").replace(/-/g, "").slice(0, 8) || "session";
}

function titleFromThread(thread) {
  if (thread?.name) {
    return thread.name;
  }

  if (thread?.cwd) {
    const base = path.basename(thread.cwd);
    if (base && base !== path.sep) {
      return base;
    }
  }

  return `Codex ${shortThreadId(thread?.id)}`;
}

function channelNameForSession(title, threadId) {
  return `codex-${title}-${shortThreadId(threadId)}`;
}

function projectNameFromCwd(cwd) {
  const base = path.basename(String(cwd || "").trim());
  return base && base !== path.sep ? base : "Unknown Project";
}

function categoryNameForProject(cwd) {
  return `Codex - ${projectNameFromCwd(cwd)}`.slice(0, 100);
}

function sessionIdentityKey(title, cwd) {
  return [
    normalizeIdentityPart(projectNameFromCwd(cwd)),
    normalizeIdentityPart(title || projectNameFromCwd(cwd))
  ].join(":");
}

function sessionIdentityKeyForThread(thread) {
  return sessionIdentityKey(titleFromThread(thread), thread?.cwd);
}

function normalizeIdentityPart(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function isTerminalTurn(turn) {
  return ["completed", "failed", "interrupted"].includes(turn?.status);
}

function seedLastSeenTurnId(turns = []) {
  if (turns.length === 0) {
    return null;
  }

  const lastTurn = turns[turns.length - 1];
  if (isTerminalTurn(lastTurn)) {
    return lastTurn.id;
  }

  const previousTerminal = [...turns].reverse().find(isTerminalTurn);
  return previousTerminal?.id || null;
}

function getNewTerminalTurns(turns = [], lastSeenTurnId, options = {}) {
  if (!lastSeenTurnId) {
    return [];
  }

  const lastSeenIndex = turns.findIndex((turn) => turn.id === lastSeenTurnId);
  if (lastSeenIndex === -1) {
    return [];
  }

  const readyTurns = [];
  for (const turn of turns.slice(lastSeenIndex + 1)) {
    if (!isTerminalTurn(turn)) {
      continue;
    }
    if (!isTurnReadyForSync(turn, options)) {
      break;
    }
    readyTurns.push(turn);
  }

  return readyTurns;
}

function getSyncableTerminalTurns(turns = [], lastSeenTurnId, options = {}) {
  if (hasInProgressAfter(turns, lastSeenTurnId)) {
    return [];
  }

  return getNewTerminalTurns(turns, lastSeenTurnId, options);
}

function hasInProgressAfter(turns = [], lastSeenTurnId) {
  const startIndex = lastSeenTurnId
    ? turns.findIndex((turn) => turn.id === lastSeenTurnId) + 1
    : 0;

  return turns.slice(Math.max(startIndex, 0)).some((turn) => turn.status === "inProgress");
}

function collectAgentMessages(turn) {
  return (turn?.items || [])
    .filter((item) => item.type === "agentMessage")
    .map(extractAgentMessageText)
    .filter(Boolean);
}

function isTurnReadyForSync(turn, options = {}) {
  if (!isTerminalTurn(turn)) {
    return false;
  }

  if (turn.status !== "interrupted") {
    return true;
  }

  if (turn.completedAt || (turn.durationMs !== null && turn.durationMs !== undefined)) {
    return true;
  }

  const nowMs = options.nowMs || Date.now();
  const graceMs = options.interruptedTurnGraceMs || 120000;
  const lastUpdateMs = secondsToMs(options.threadUpdatedAt) || secondsToMs(turn.startedAt);
  if (!lastUpdateMs) {
    return true;
  }

  return nowMs - lastUpdateMs >= graceMs;
}

function shouldSkipUnchangedThread(threadSummary = {}, session = {}) {
  const threadUpdatedAt = Number(threadSummary.updatedAt);
  const lastSeenThreadUpdatedAt = Number(session.lastSeenThreadUpdatedAt);
  if (!Number.isFinite(threadUpdatedAt) || threadUpdatedAt <= 0) {
    return false;
  }
  if (!Number.isFinite(lastSeenThreadUpdatedAt) || lastSeenThreadUpdatedAt <= 0) {
    return false;
  }

  return threadUpdatedAt <= lastSeenThreadUpdatedAt;
}

function isThreadRecentlyUpdated(threadSummary = {}, nowMs = Date.now(), quietMs = 0) {
  const updatedAtMs = secondsToMs(threadSummary.updatedAt);
  if (!updatedAtMs || !Number.isFinite(Number(quietMs)) || Number(quietMs) <= 0) {
    return false;
  }

  return nowMs - updatedAtMs < Number(quietMs);
}

function secondsToMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number * 1000 : null;
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

module.exports = {
  categoryNameForProject,
  collectAgentMessages,
  channelNameForSession,
  getNewTerminalTurns,
  getSyncableTerminalTurns,
  hasInProgressAfter,
  isThreadRecentlyUpdated,
  isTerminalTurn,
  isTurnReadyForSync,
  seedLastSeenTurnId,
  shouldSkipUnchangedThread,
  shortThreadId,
  projectNameFromCwd,
  secondsToMs,
  sessionIdentityKey,
  sessionIdentityKeyForThread,
  titleFromThread
};
