# CLAUDE.md — Ari's EA Agent

This file is read at runtime: the **Role rules** section below is injected into the
classification prompt (`src/ai/classify.js`). Edit it in plain English and restart the
server; no code change needed. The full build spec is in `SPEC.md`.

## Role rules

<!-- EDIT ME: replace the examples below with Ari's real rules. Keep them short and concrete. -->

**Ari's job (bucket = mine)**
- Decisions, approvals and sign-offs that only Ari can give.
- Anything Ari personally promised to deliver (a doc, a call, an intro, a reply).
- Replies to senior management, key clients, investors and partners.
- Prep for meetings Ari is running or presenting in.

**Not Ari's job (bucket = not_mine)**
- Execution work that belongs to a named team member in `config/roles.json`; set them as owner.
- Action items assigned to someone else in a meeting.
- FYI / CC emails where Ari is not asked to do anything specific (usually no task at all).

**Blocking me**: set `blocking_me = true` when Ari cannot finish one of Ari's own tasks or
decisions until the owner delivers.

**Priority**
- P1: due within 24h, or senior management / key client waiting, or money/legal at risk.
- P2: due this week, or blocking someone else.
- P3: due later, normal importance.
- P4: nice to have, no date.

**Follow-up date (Not My Job)**: one working day before the due date; if there is no due
date, 3 working days from today. Working days are Mon–Sat.

## Project conventions
- Node 22.13+ ESM, Express, built-in `node:sqlite`, node-cron (IST), vanilla-JS dashboard.
- All prompts live in `src/ai/prompts.js`; keep `PROMPTS.md` in sync when you change them.
- Times are stored as UTC ISO strings and shown in IST.
