# PROMPTS.md

The prompt text lives in `src/ai/prompts.js`; this file explains how the prompts are wired. Change the
prompts there and keep this summary in sync.

| Step | Prompt | Schema | Effort | Called from |
|---|---|---|---|---|
| 4a Email → summary + tasks | `EXTRACT_EMAIL_SYSTEM` + `extractEmailUser()` | `EXTRACT_EMAIL_SCHEMA` | medium | `ai/extract.js` ← `jobs/syncGmail.js` |
| 4b Task → bucket/owner/priority | `CLASSIFY_SYSTEM` + `classifyUser()` | `CLASSIFY_SCHEMA` | low | `ai/classify.js` ← every task ingest |
| 4c Meeting notes → summary/decisions/actions | `MEETING_NOTES_SYSTEM` + `meetingNotesUser()` | `MEETING_NOTES_SCHEMA` | medium | `ai/extract.js` ← `jobs/meetingNotes.js` |

## How a call is built
- **Model**: `ANTHROPIC_MODEL` (default `claude-opus-5-5`), called through `integrations/anthropic.js`.
- **Structured output**: `output_config.format` with a JSON schema, so the reply is always valid JSON.
- **Caching**: the system prompt is stable (it changes only when you edit `CLAUDE.md`, `config/roles.json` or `config/projects.json`) and is marked `cache_control`. Everything that changes per call goes in the user message: the current IST time, the email, and the overrides.
- **Refusal fallback**: `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) re-runs a declined request on Anthropic's recommended fallback model.

## Placeholders filled by `render()`
- `{{ROLE_RULES}}`: the `## Role rules` section of `CLAUDE.md`.
- `{{ME}}`: `roles.json → me`.
- `{{PEOPLE}}`: `roles.json → people`, with their name, email, team, role and what they own.
- `{{PROJECTS}}`: the project tags from `config/projects.json`.

## Learning from corrections
Every "Wrong bucket?" save, and every move between My Job and Not My Job, writes a row to `overrides`.
The latest 30 rows go into the classify prompt as "Recent corrections by Ari", which the prompt tells the
model to weigh most heavily. A task with confidence below 0.6 gets a **Review** badge.
