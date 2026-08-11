"use strict";

function formatNotifyMessage(payload) {
  const event = payload.type || payload.event || payload.notification_type || "codex";
  const title = payload.title || payload.message || payload.summary || "Codex notification";
  const status = payload.status || payload.result || payload.outcome;
  const cwd = payload.cwd || payload.working_directory || payload.workingDirectory;

  const lines = [`**${title}**`, `Event: \`${event}\``];

  if (status) {
    lines.push(`Status: \`${status}\``);
  }

  if (cwd) {
    lines.push(`CWD: \`${cwd}\``);
  }

  return lines.join("\n");
}

module.exports = {
  formatNotifyMessage
};
