---
name: insight
description: Generate a Codex session insights dashboard from recent session history and optional memory context. Use when the user invokes @insight or asks for Codex workflow/session insights.
---

# Codex Session Insights

Use this skill when the user asks for `@insight`, `/insight`, or an operational summary of recent Codex work.

## Workflow

1. Capture the folder where the skill was triggered before changing directories. From the plugin root, run:

   ```bash
   CODEX_INSIGHTS_OUTPUT_DIR="$TRIGGER_DIR" node scripts/codex-session-insights.mjs
   ```

2. Pass through user options when supplied:

   ```bash
   CODEX_INSIGHTS_OUTPUT_DIR="$TRIGGER_DIR" node scripts/codex-session-insights.mjs --days 30 --no-memory
   CODEX_INSIGHTS_OUTPUT_DIR="$TRIGGER_DIR" node scripts/codex-session-insights.mjs --no-ai
   CODEX_INSIGHTS_OUTPUT_DIR="$TRIGGER_DIR" node scripts/codex-session-insights.mjs --export markdown
   ```

3. Share the generated report path. The HTML report is always named `codex-insights.html` and written to the folder where the skill was triggered, unless the user explicitly supplies an output directory.

## Notes

- The analyzer redacts obvious secrets before synthesis or rendering.
- Missing history, session, or memory files should degrade into a sparse report instead of failing.
- If qualitative synthesis is unavailable, use the deterministic report sections.
