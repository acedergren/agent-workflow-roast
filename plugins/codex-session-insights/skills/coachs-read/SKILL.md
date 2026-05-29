---
name: coachs-read
description: Produce a privacy-preserving Coach's Read from precomputed Codex session metrics. Use when the user provides or references already-computed session stats, friction counts, prompt-quality signals, token/effectiveness metrics, or insight JSON and wants coaching rather than fresh data collection.
---

# Coach's Read

Use this skill when the metrics are already computed and the user wants a coaching synthesis. Do not read raw Codex session JSONL, memory files, history files, or secrets unless the user explicitly asks for a fresh `/insight` run.

## Inputs

Work only from provided or precomputed artifacts such as:

- Aggregated project, tool, friction, planning, verification, goal, token, and effectiveness metrics.
- Redacted examples or evidence snippets.
- Existing `codex-session-insights` JSON, markdown, or HTML report content.

If the input lacks evidence for a claim, say the signal is weak or unavailable. Do not infer identities, private context, root causes, dates, costs, or behavioral patterns beyond the provided metrics.

## Privacy Rules

- Treat session history, memory, prompts, URLs, emails, tokens, credentials, and local paths as private.
- Preserve existing redaction. Do not ask for raw dumps when aggregate metrics or redacted snippets are enough.
- Quote only short redacted evidence snippets that the user already provided.
- For secrets/auth topics, discuss verification behavior without exposing values.

## Output Contract

Produce a concise Coach's Read with these sections:

1. `Summary`: one evidence-grounded paragraph about the working pattern.
2. `Friction Coaching`: friction categories, observed counts when available, redacted evidence, likely habit to change, and a copy-ready rule.
3. `Custom Instructions`: paste-ready first-person guidance for Codex Settings > Custom instructions.
4. `Workflow Prompts`: prompts for improving repo instructions, project skills, or specialist agents. Each prompt must require project inspection first.
5. `Action Prompts`: copy-ready prompts for concrete artifacts such as scripts, AGENTS.md rules, project skills, specialist agents, custom instructions, or checklists.
6. `Skill/Agent Suggestions`: recommended skills or agents, with target, why it helps, and a creation prompt.
7. `Effectiveness Metrics`: prompt quality, output effectiveness, token effectiveness, planning clarity, and goal/acceptance clarity. Label proxy metrics honestly.

## Coaching Style

- Be direct, kind, and practical.
- Prefer behavior changes and durable artifacts over abstract advice.
- Map repeated friction to one next action and one reusable rule.
- Separate measured facts from interpretation.
- Avoid invented precision. Use phrases like "the provided metrics suggest" or "no provided metric proves this" when appropriate.

## Minimal Prompt Pattern

```text
Using only these precomputed session metrics and redacted snippets, produce a Coach's Read. Preserve privacy, do not invent facts, and include Summary, Friction Coaching, Custom Instructions, Workflow Prompts, Action Prompts, Skill/Agent Suggestions, and Effectiveness Metrics. Label proxy metrics honestly.
```
