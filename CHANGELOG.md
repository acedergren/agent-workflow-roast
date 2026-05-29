# Changelog

All notable changes to Codex Insights are documented here.

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
