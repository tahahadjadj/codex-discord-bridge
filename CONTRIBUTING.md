# Contributing

## Development

Requires Node.js 20 or newer and a local Codex installation that provides
`codex app-server`.

```bash
npm ci
cp .env.example .env
npm test
npx eslint .
```

Never commit `.env`, Discord tokens, downloaded attachments, logs, or
`data/session-map.json`.

## Changes

1. Keep changes focused and add tests for behavior changes.
2. Update `docs/knowledge-base.md` when runtime behavior changes.
3. Run the test and lint commands before opening a pull request.
4. Use a short, present-tense commit message.

Pull requests should explain the behavior changed, its user impact, and the
checks used to validate it.
