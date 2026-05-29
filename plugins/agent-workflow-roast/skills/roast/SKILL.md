---
name: roast
description: Generate an Agent Workflow Roast report from recent local session history and optional memory context. Use when the user invokes @roast, /roast, or asks for workflow coaching with receipts.
---

# Agent Workflow Roast

Use this skill when the user asks for `@roast`, `/roast`, or a coaching report for recent agent work.

## Workflow

1. Capture the folder where the skill was triggered before changing directories. From the plugin root, run:

   ```bash
   AGENT_WORKFLOW_ROAST_OUTPUT_DIR="$TRIGGER_DIR" node scripts/agent-workflow-roast.mjs
   ```

2. Pass through user options when supplied:

   ```bash
   AGENT_WORKFLOW_ROAST_OUTPUT_DIR="$TRIGGER_DIR" node scripts/agent-workflow-roast.mjs --days 30 --no-memory
   AGENT_WORKFLOW_ROAST_OUTPUT_DIR="$TRIGGER_DIR" node scripts/agent-workflow-roast.mjs --no-ai
   AGENT_WORKFLOW_ROAST_OUTPUT_DIR="$TRIGGER_DIR" node scripts/agent-workflow-roast.mjs --export markdown
   ```

3. Share the generated report path. The HTML report is always named `agent-workflow-roast.html` and written to the folder where the skill was triggered, unless the user explicitly supplies an output directory.

## Notes

- The analyzer redacts obvious secrets before synthesis or rendering.
- Missing history, session, or memory files should degrade into a sparse report instead of failing.
- If qualitative synthesis is unavailable, use the deterministic report sections.
