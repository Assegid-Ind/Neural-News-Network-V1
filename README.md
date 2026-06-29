# Neural News Network

An autonomous local newspaper prototype that:

- ingests recent RSS headlines and summaries from selected news sources
- clusters related reports into story groups
- builds a neutral fact pack for each story
- sends the same fact pack to Greek-aliased editorial agents
- hides each agent's underlying perspective until creator mode is unlocked
- lets the creator add historically trained agents from pasted writings

## Run

This Codex desktop environment does not expose global `npm`, so use the bundled pnpm:

```powershell
$env:Path='C:\Users\baroc\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:Path
& 'C:\Users\baroc\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\pnpm.cmd' install
& 'C:\Users\baroc\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\pnpm.cmd' run dev
```

Then open:

```txt
http://127.0.0.1:5173/
```

The API runs at `http://127.0.0.1:4177`.

## Creator Mode

Click `Creator` and enter the creator key.

Default local key:

```txt
creator
```

Set `CREATOR_KEY` before starting the server to change it.

Manual refresh is creator-only. Public readers receive cached issues, and the server ignores forced refresh requests unless the `x-creator-key` header matches `CREATOR_KEY`.

## Publish

The production server serves both the API and the built website from one Node process.

Recommended settings for Render, Railway, or Fly.io:

```txt
Build command: npm install && npm run build
Start command: npm start
Environment: CREATOR_KEY=<your private creator key>
```

The app uses the platform `PORT` automatically. For local production testing:

```powershell
npm run build
npm start
```

## Notes

The ingestion engine starts with RSS, then attempts to fetch and extract readable article pages for the strongest candidates. Publishers that block extraction gracefully fall back to feed text. Each story cluster now keeps source dossiers, extracted claims, dates, numbers, context, open questions, and a richer fact pack used by the editorial agents.
