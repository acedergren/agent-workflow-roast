# Humanized Insight Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make `/insight` produce a less repetitive, more human coaching report with source-backed signals, one canonical recommendation list, and targeted UI/chart tests.

**Architecture:** Keep the analyzer dependency-light and centered in `scripts/codex-session-insights.mjs`. Add canonical `signals[]`, `recommendations[]`, and `voiceReview` fields to the report while preserving legacy insight fields for compatibility. Render the UI from the canonical recommendation list, then derive older sections from those cards.

**Tech Stack:** Node.js ESM, `node:test`, dependency-free analyzer code, and targeted Playwright UI tests.

---

### Task 1: Tests for signal and recommendation contracts

**Files:**
- Modify: `tests/codex-session-insights.test.mjs`

- [x] Add tests proving `error`, `failed`, and `failure` collapse into one `build-action-failures` signal.
- [x] Add tests proving every recommendation has valid `signalIds`.
- [x] Add tests proving copy-ready prompts are deduped below the similarity threshold.
- [x] Add tests proving humanized copy removes banned AI phrases while preserving commands and paths.
- [x] Run `npm test` and confirm the new tests fail before implementation.

### Task 2: Canonical signal and recommendation pipeline

**Files:**
- Modify: `scripts/codex-session-insights.mjs`

- [x] Add `buildSignals(stats)` with stable signal IDs, counts, examples, projects, source kinds, confidence, and recommended artifact types.
- [x] Add `buildRecommendations(stats, insights, signals)` so all actions cite source signals and have one primary placement.
- [x] Add prompt similarity helpers and dedupe recommendations by normalized wording.
- [x] Add `voiceReview` with banned phrase findings and rewrite decisions.
- [x] Ensure `buildReport()` returns `signals`, `recommendations`, and `voiceReview`.

### Task 3: Humanizer/editor pass

**Files:**
- Modify: `scripts/codex-session-insights.mjs`

- [x] Add a voice contract that requires plainspoken coaching, specific evidence, short useful roast, and no inflated filler.
- [x] Update synthesis prompt to use signal cards and require source IDs.
- [x] Add a second `codex exec` editor pass when AI is enabled.
- [x] Add deterministic fallback humanization for all user-facing text when AI is disabled or fails.
- [x] Preserve exact commands, file paths, JSON keys, and copy-ready prompt safety wording.

### Task 4: Simplified report rendering

**Files:**
- Modify: `templates/report.html`
- Modify: `scripts/codex-session-insights.mjs`
- Modify: `assets/report.css`

- [x] Replace overlapping sections with `Coach read`, `Coaching targets`, `Top actions`, `Prompt quality`, and `Evidence`.
- [x] Render action cards from canonical recommendations only.
- [x] Show signal evidence and counts on action cards.
- [x] Keep compatibility content in Markdown/JSON without rendering duplicate advice in HTML.
- [x] Keep copy buttons and long prompt wrapping responsive.

### Task 5: Targeted UI and chart tests

**Files:**
- Modify: `package.json`
- Create: `playwright.config.mjs`
- Create: `tests/report-ui.spec.mjs`

- [x] Add `@playwright/test` as a dev dependency and `npm run test:ui`.
- [x] Generate a deterministic report fixture in the test temp directory.
- [x] Assert desktop and mobile layouts have no horizontal overflow.
- [x] Assert token chart SVG, bars, lines, dates, and legend render.
- [x] Assert a copy button changes to `Copied` using locator waits, not sleeps.

### Task 6: Verification and commit

**Files:**
- Modify only files required by the tasks above.

- [x] Run `npm test`.
- [x] Run `npm run test:ui`.
- [x] Run `npm run validate:plugin`.
- [x] Run `git diff --check`.
- [x] Commit focused changes.
