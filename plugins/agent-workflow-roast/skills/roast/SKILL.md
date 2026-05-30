---
name: roast
description: Generate an Agent Workflow Roast report from recent local session history and optional memory context. Use when the user invokes @roast, /roast, or asks for workflow coaching with receipts.
---

# Agent Workflow Roast

Use this skill when the user asks for `@roast`, `/roast`, or a coaching report for recent agent work.

## Workflow

If the user provides existing Agent Workflow Roast JSON, markdown, HTML, aggregate metrics, or redacted evidence and asks for interpretation, work from that provided material only. Do not read raw session JSONL, memory files, history files, or secrets unless the user explicitly asks for a fresh `/roast` run.

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
- Treat precomputed metrics and redacted report content as enough for follow-up coaching; ask for a fresh run only when the user wants updated data.
- Missing history, session, or memory files should degrade into a sparse report instead of failing.
- If qualitative synthesis is unavailable, use the deterministic report sections.
