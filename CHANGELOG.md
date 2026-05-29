# Changelog

All notable changes to Agent Workflow Roast are documented here.

## [0.2.1] - 2026-05-29

### Changed

- Changed the default report lookback to a rolling 7-day window when `--days` is omitted.
- Renamed the GitHub repository to `acedergren/agent-workflow-roast` and updated public install URLs.

## [0.2.0] - 2026-05-29

### Changed

- Renamed the public product and report title to Agent Workflow Roast.
- Made `/roast` and `@roast` the primary command and skill surfaces.
- Renamed the default HTML artifact to `agent-workflow-roast.html`.
- Updated plugin metadata, marketplace catalog, package metadata, README, release notes, tests, and playground paths for the new brand.
- Initially kept the GitHub repository at `acedergren/codex-insights` for install continuity while exposing the marketplace plugin as `agent-workflow-roast`.

### Compatibility

- Kept `npm run insight` as a repository-local alias for `npm run roast --`.
- Kept legacy `CODEX_INSIGHTS_*` environment variables as fallbacks while documenting the new `AGENT_WORKFLOW_ROAST_*` names.

### Verification

- `npm test`
- `npm run test:ui`
- `npm run validate:plugin`
- `git diff --check`
- Clean marketplace install smoke with `codex plugin add agent-workflow-roast@agent-workflow-roast`

## [0.1.4] - 2026-05-29

### Added

- Added humanizer guidance directly to the LLM system prompt used for insight synthesis.
- Added the same humanizer guidance to the editor/dedupe pass so generated report prose is clearer, more specific, and less AI-shaped.
- Added regression tests that verify both prompt passes include the humanizer instructions.

### Changed

- Expanded the banned AI-tell list used by deterministic cleanup to catch phrases such as `underscores`, `foster`, `garner`, `intricate`, `tapestry`, `serves as`, and `stands as`.
- Updated the README install path to use `v0.1.4`.

### Verification

- `npm test`
- `npm run validate:plugin`
- `git diff --check`
- Fresh AI-enabled report generation to `codex-insights.html`

## [0.1.3] - 2026-05-29

### Fixed

- Packaged the plugin under `plugins/codex-session-insights/` so Codex marketplace installs can discover it.
- Updated the marketplace catalog to point at the installable plugin package instead of the repository root.
- Added a regression test that checks the marketplace catalog path and required plugin files.

### Changed

- Updated the README install path to use `v0.1.3`.
- Pointed development scripts and validation at the nested plugin package.

### Verification

- `npm test`
- `npm run validate:plugin`
- `npm run test:ui`
- `git diff --check`
- Clean GitHub marketplace install smoke with `codex plugin add codex-session-insights@codex-insights`

## [0.1.2] - 2026-05-29

### Fixed

- Verified token spend is remeasured from current local input files on every report run.
- Wrote default HTML output as `codex-insights.html` in the invocation folder.
- Split the Good / Bad / Ugly summary from Coach's Read so the report does not repeat the same advice in two shapes.

## [0.1.1] - 2026-05-29

### Added

- Public marketplace install instructions.
- Humanized coaching output with canonical signals, recommendations, and voice review.
- Copy-ready prompts for repo guidance, skills, agents, custom instructions, and project workflow artifacts.

## [0.1.0] - 2026-05-28

### Added

- Initial local Codex session-insights plugin.
- `/insight` command, `@insight` skill, HTML report, markdown/json export, and deterministic `--no-ai` fallback.
