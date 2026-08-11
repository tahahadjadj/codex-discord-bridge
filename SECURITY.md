# Security Policy

## Reporting a Vulnerability

Do not open a public issue for a vulnerability that could expose credentials
or permit remote code execution. Use GitHub's private vulnerability reporting
for this repository instead.

Include the affected version, reproduction steps, impact, and any suggested
mitigation. Do not include live Discord tokens or other credentials.

## Deployment Boundary

This bridge turns authorized Discord messages into instructions for a local
Codex process. Treat every authorized Discord account and bot token as access
to the configured Codex sandbox.

- Set `OWNER_DISCORD_USER_IDS`; an empty value allows any server member who can
  post in a mirrored channel to trigger Codex.
- Start with `CODEX_SANDBOX=workspace-write` and
  `CODEX_APPROVAL_POLICY=on-request`.
- Use `danger-full-access` only on a dedicated machine with a tightly restricted
  Discord server and an understood host compromise risk.
- Rotate the Discord token immediately if it appears in chat, logs, commits, or
  screenshots.
- Keep `.env`, logs, attachment files, and session mappings out of Git.

This project has not undergone a formal security audit.
