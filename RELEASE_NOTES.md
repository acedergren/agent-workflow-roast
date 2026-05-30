# Release Notes

## v0.2.2

Agent Workflow Roast now has one clean skill surface: `@roast`. The separate `coachs-read` skill was useful as scaffolding, but it made users choose between two overlapping ways to ask for the same coaching. Its privacy rule now lives in the main skill.

### Highlights

- Removed the separate `coachs-read` skill.
- Added precomputed-report coaching guidance to the main `roast` skill.
- Added the cartoon Agent Workflow Roast icon to the README and plugin assets.
- Kept `/roast` as the single default workflow for fresh reports and follow-up coaching.

### Install

```bash
codex plugin marketplace add acedergren/agent-workflow-roast --ref v0.2.2
codex plugin add agent-workflow-roast@agent-workflow-roast
```

If you already added the marketplace:

```bash
codex plugin marketplace upgrade agent-workflow-roast
codex plugin add agent-workflow-roast@agent-workflow-roast
```

### Verification

- `npm test`
- `npm run validate:plugin`
- `git diff --check`
