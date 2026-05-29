# Release Notes

## v0.2.1

Agent Workflow Roast now lives at its matching GitHub home: `acedergren/agent-workflow-roast`. The default report also uses the normal coaching window now: rolling 7 days when `--days` is omitted.

### Highlights

- GitHub repository renamed to `acedergren/agent-workflow-roast`.
- Plugin metadata now points at the renamed repository.
- `/roast` with no `--days` uses a rolling 7-day window.
- README and release docs use the new marketplace source URL.

### Install

```bash
codex plugin marketplace add acedergren/agent-workflow-roast --ref v0.2.1
codex plugin add agent-workflow-roast@agent-workflow-roast
```

If you already added the old marketplace:

```bash
codex plugin marketplace upgrade agent-workflow-roast
codex plugin add agent-workflow-roast@agent-workflow-roast
```

### Verification

- `npm test`
- `npm run validate:plugin`
- `git diff --check`
- No-AI smoke run with omitted `--days`, producing a 7-day report
