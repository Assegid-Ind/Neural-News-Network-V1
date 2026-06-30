# Neural News Network

An autonomous local newspaper prototype that:

- ingests recent RSS headlines and summaries from selected news sources
- clusters related reports into story groups
- builds a neutral fact pack for each story
- sends the same fact pack to Greek-aliased editorial agents
- hides each agent's underlying perspective until creator mode is unlocked
- lets the creator add historically trained agents from pasted writings


## Notes

The ingestion engine starts with RSS, then attempts to fetch and extract readable article pages for the strongest candidates. Publishers that block extraction gracefully fall back to feed text. Each story cluster keeps source dossiers, extracted claims, dates, numbers, context, open questions, and a richer fact pack used by the editorial agents.

## AI generation

Set `OPENAI_API_KEY` on the server to generate agent-written articles through OpenAI during each refresh. Without a key, the app falls back to the local deterministic writers so the site still runs.

Useful environment variables:

- `OPENAI_API_KEY`: server-only OpenAI API key. Never commit this.
- `OPENAI_MODEL`: defaults to `gpt-4.1-mini`.
- `OPENAI_AGENT_CONCURRENCY`: defaults to `2`.
- `OPENAI_MAX_OUTPUT_TOKENS`: defaults to `1400`.
- `CREATOR_KEY`: unlocks creator-only refresh controls.
