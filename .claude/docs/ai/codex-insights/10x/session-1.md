# 10x Analysis: Codex Insights
Session 1 | Date: 2026-05-28

## Current Value

Codex Insights turns recent local Codex sessions into a coaching report. Today it ingests local history/session files, optionally uses memory, redacts sensitive material, runs an LLM synthesis pass, and renders an HTML/Markdown/JSON report. The core user is a power Codex user who runs many project workflows and wants to see where agent work is effective, where it loops, and what durable guidance would improve future sessions.

The core action is not "read analytics." The core action is: **turn messy session history into better future Codex behavior**.

Evidence in the repo:
- `README.md` frames the product around "where is my agent work going, what keeps slowing it down, and what local rules or prompts would make the next run better?"
- `scripts/codex-session-insights.mjs` already generates coaching, custom instructions, action prompts, project workflow prompts, and recommended skills/agents.
- `templates/report.html` now presents metrics, coaching, custom instructions, action prompts, skills/agents, and supporting context.

The current product is already pointed in the right direction. The miss is that the UI still presents too much as a report and not enough as a **workflow improvement cockpit**.

## The Question

What would make Codex Insights 10x more valuable?

Make users leave the report with durable upgrades applied or ready to apply: better custom instructions, better `AGENTS.md`, better project skills, specialist agents, scripts, and checklists. The report should make the good, bad, and ugly obvious, then coach the user toward the next artifact to create.

---

## Massive Opportunities

### 1. Artifact Compiler

**What**: Convert coaching signals into ready-to-apply artifacts: custom instructions, `AGENTS.md` diffs, skill skeletons, specialist agent specs, scripts, and checklists.

**Why 10x**: The user should not merely learn "you need better workflow rules." The product should hand them the exact durable changes that make future Codex sessions better. This changes Codex Insights from a dashboard into a behavior-upgrade generator.

**Unlocks**: One-click or copy-ready workflow hardening for every recurring project lane.

**Effort**: High

**Risk**: Generated artifacts may overreach if the report does not distinguish global behavior from repo-specific guidance.

**Score**: 🔥 Must do

### 2. Guidance Map Engine

**What**: A standard rule engine that maps every signal into the right artifact type:

| Signal Type | Default Artifact |
|-------------|------------------|
| Global working preference | Custom Instructions |
| Repo-specific behavior | `AGENTS.md` |
| Repeated command sequence | Script |
| Recurring project lane | Project skill |
| Judgment-heavy triage | Specialist agent |
| Completion ambiguity | Checklist |
| Security/auth/release risk | Skill or agent plus `AGENTS.md` safety rule |

**Why 10x**: The product becomes consistent and teachable. Users can understand why something became a skill instead of a custom instruction.

**Unlocks**: Better trust, fewer random-looking recommendations, easier tests.

**Effort**: Medium/High

**Risk**: Too rigid a mapper could miss nuance. Keep confidence and rationale visible.

**Score**: 🔥 Must do

### 3. Workflow Memory Loop

**What**: Track whether accepted suggestions actually reduce loops over time. Example: "You added an auth debugging skill last week; auth retry loops dropped 38%."

**Why 10x**: This creates compounding value. The product stops being a one-off report and becomes a coaching system that learns whether workflow interventions work.

**Unlocks**: Habit formation, longitudinal coaching, and real "did this help?" proof.

**Effort**: High

**Risk**: Needs careful privacy and local-first persistence.

**Score**: 👍 Strong

---

## Medium Opportunities

### 1. Good / Bad / Ugly Narrative Strip

**What**: Replace scattered narrative with three explicit coaching blocks:

- **Good**: What the user should keep doing.
- **Bad**: What is costing loops or tokens.
- **Ugly**: The most painful recurring pattern, with the roast and the highest-leverage fix.

**Why 10x**: It makes the report emotionally legible. Users should immediately understand their workflow pattern without reading every panel.

**Impact**: Stronger coaching, faster scan, more memorable recommendations.

**Effort**: Medium

**Score**: 🔥 Must do

### 2. "What To Create Next" Queue

**What**: A ranked queue of 3-7 durable artifacts to create next. Each item has artifact type, target repo, effort, expected payoff, copy-ready prompt, and "why this mapping."

**Why 10x**: The report becomes an action queue, not a museum of insights.

**Impact**: Users can start improving immediately.

**Effort**: Medium

**Score**: 🔥 Must do

### 3. Prompt Quality Studio

**What**: Show before/after prompt patterns tied to the user’s real failure modes:

- vague prompt
- improved prompt
- reusable prompt template
- expected acceptance proof

**Why 10x**: Prompt quality is one of the most coachable levers and probably the fastest way to reduce loops.

**Impact**: Better user behavior, fewer clarification turns, lower token waste.

**Effort**: Medium

**Score**: 👍 Strong

### 4. Skill/Agent Blueprint Cards

**What**: Cards for recommended skills and agents with a standardized structure:

- Name
- Lane
- Trigger
- Inputs needed
- Inspection steps
- Commands
- Safety rules
- Done criteria
- Copy-ready creation prompt

**Why 10x**: Converts "create a workflow skill per recurring lane" into immediately usable blueprints.

**Impact**: Stronger follow-through; fewer vague "maybe make a skill" suggestions.

**Effort**: Medium

**Score**: 🔥 Must do

### 5. Evidence-First Caveats

**What**: Every metric and suggestion should show its evidence basis:

- measured
- proxy
- inferred
- weak signal

**Why 10x**: The user is already evidence-oriented. The product should earn trust by being honest about weak signals.

**Impact**: Better trust, less overclaiming.

**Effort**: Low/Medium

**Score**: 👍 Strong

---

## Small Gems

### 1. Rename "Effectiveness Dashboard" to "Coaching Targets"

**What**: The current dashboard title sounds analytical. The actual value is behavior change.

**Why powerful**: It reframes the panel from "observe metrics" to "improve this."

**Effort**: Low

**Score**: 🔥 Must do

### 2. Add Artifact Type Badges Everywhere

**What**: Use consistent badges: `Custom Instructions`, `AGENTS.md`, `Skill`, `Agent`, `Script`, `Checklist`.

**Why powerful**: Users instantly know where each recommendation belongs.

**Effort**: Low

**Score**: 🔥 Must do

### 3. Add "Why This Artifact?"

**What**: Under every recommended artifact, explain why it maps there.

**Why powerful**: It teaches the user how to think about workflow improvements.

**Effort**: Low

**Score**: 👍 Strong

### 4. Show "Copy This" Blocks First, Explanation Second

**What**: For copy-ready sections, put the actual prompt or instruction before explanatory prose.

**Why powerful**: The user came for actionable output; do not make them dig.

**Effort**: Low

**Score**: 🔥 Must do

### 5. Collapse Supporting Evidence By Default

**What**: Keep Memory Context, raw friction table, and context stats behind details/accordion sections.

**Why powerful**: It reduces cognitive load and keeps the main report focused on action.

**Effort**: Low/Medium

**Score**: 👍 Strong

---

## UI/UX Changes

### Current Problem

The UI still has a report-shaped mental model:

1. metrics
2. coaching
3. copy-ready prompts
4. supporting context

That is better than before, but the mission wants:

1. what is good/bad/ugly
2. what to change
3. where to put the change
4. copy-ready artifact
5. evidence if the user wants to inspect it

### Proposed Information Architecture

#### 1. Executive Coaching Header

Above all cards:

- **Good**: one sentence
- **Bad**: one sentence
- **Ugly**: one sentence with a useful roast
- **Next best move**: one artifact to create first

This should replace the current generic report intro.

#### 2. Coaching Targets

Rename `Effectiveness Dashboard` to `Coaching Targets`.

Each metric card should include:

- score
- target behavior
- artifact target
- copy-ready guidance update
- apply prompt

Example:

```text
Prompt quality · 74
Target behavior: Always include goal, scope, constraints, and proof.
Best artifact: Custom Instructions + AGENTS.md rule
Copy-ready update: For non-trivial work, start by restating...
```

#### 3. Create These Artifacts

This should be the primary action section. It should merge the best of Action Builder Prompts and Recommended Skills & Agents.

Columns:

- Priority
- Artifact
- Target
- Why
- Copy-ready prompt

Artifact examples:

- Custom Instructions update
- `AGENTS.md` repo rule
- Portal release/auth skill
- Build/action failure triage agent
- Auth and secret verification agent

#### 4. Prompt Quality Studio

Show:

- "Your likely prompt smell"
- "Better prompt"
- "Reusable prompt pattern"
- "Definition of done"

This is where the user learns how to ask better next time.

#### 5. Evidence Drawer

Everything else goes lower:

- context snapshot
- friction table
- memory context
- project distribution

Do not remove it. Just stop making it first-class.

---

## New Features

### 1. Apply Pack Export

**What**: Export a folder or Markdown bundle:

```text
codex-insights-apply-pack/
  CUSTOM_INSTRUCTIONS.md
  AGENTS_PATCHES.md
  SKILLS_TO_CREATE.md
  AGENTS_TO_CREATE.md
  SCRIPTS_TO_CREATE.md
  CHECKLISTS.md
```

**Why**: The user can run the report, then walk repo-by-repo applying durable workflow upgrades.

**Score**: 🔥 Must do

### 2. Artifact Mapper With Tests

**What**: Centralize mapping in `mapSignalToArtifact(signal)` with fixtures.

**Why**: Prevents random recommendations and creates a durable product brain.

**Score**: 🔥 Must do

### 3. Per-Project Lane Profiles

**What**: Generate a profile per recurring lane:

- portal release/auth
- observability verification
- quiz security
- Oracle memory
- Codex plugin development

Each profile includes recommended skill, agent, `AGENTS.md` rule, commands, and done criteria.

**Score**: 🔥 Must do

### 4. "Accepted / Ignored / Applied" State

**What**: Let the user mark suggestions as accepted, ignored, or applied.

**Why**: Over time the report can learn which interventions matter.

**Score**: 👍 Strong

### 5. Follow-up Report Delta

**What**: Show whether applying artifacts improved future sessions.

Example:

```text
After adding auth verification rules:
- Auth friction: down 23%
- Reauth loops: down 2 sessions
- Token exposure risk: unchanged
```

**Score**: 👍 Strong

---

## Recommended Priority

### Do Now

1. **Rename and refocus Effectiveness Dashboard into Coaching Targets**
   - Why: The product is about behavior change, not analytics.
   - Impact: Immediately clarifies the mission.

2. **Add a Good / Bad / Ugly coaching header**
   - Why: Makes the user aware of workflow reality in one glance.
   - Impact: Stronger emotional and practical clarity.

3. **Merge action prompts and skill/agent recommendations into "Create These Artifacts"**
   - Why: The current split creates duplication.
   - Impact: One clear action queue.

4. **Add artifact mapping rationale**
   - Why: Teaches why something belongs in Custom Instructions vs `AGENTS.md` vs skill vs agent.
   - Impact: Higher trust, less confusion.

### Do Next

1. **Build the standardized artifact mapper**
   - Why: Makes recommendations consistent and testable.
   - Unlocks: Better UI, better exports, better future features.

2. **Add Prompt Quality Studio**
   - Why: Prompt quality is the most coachable, high-frequency improvement lever.
   - Unlocks: Reusable prompt templates and better user behavior.

3. **Add Apply Pack export**
   - Why: Turns insight into an implementation workflow.
   - Unlocks: Repo-by-repo durable upgrades.

### Explore

1. **Longitudinal improvement tracking**
   - Why: Shows whether workflow changes actually reduce loops.
   - Risk: Requires careful local storage and privacy design.
   - Upside: Compounding coaching.

2. **Accepted/applied suggestion state**
   - Why: Turns the report into an ongoing workflow improvement system.
   - Risk: More product complexity.
   - Upside: The report becomes personalized over time.

### Backlog

1. **More decorative visualization**
   - Why later: Visuals help, but only after the action model is crisp.

2. **Team sharing**
   - Why later: This product is currently strongest as a local personal coach.

---

## Questions

### Answered

- **Q**: What is the core mission?
  **A**: Make the user aware of workflow strengths and weaknesses, then turn that awareness into durable Codex behavior upgrades.

- **Q**: What is the main UX problem?
  **A**: The report still behaves too much like analytics and not enough like a coach that hands the user the next artifact to create.

- **Q**: What should be first-class?
  **A**: Good/bad/ugly coaching, prompt quality, and copy-ready artifact creation.

### Blockers

- **Q**: Should the tool eventually write artifact files directly?
  **A**: Needs product decision. It is powerful, but higher-risk than copy-ready prompts.

## Next Steps

- [ ] Rename `Effectiveness Dashboard` to `Coaching Targets`.
- [ ] Add Good / Bad / Ugly top summary.
- [ ] Merge Action Builder Prompts and Recommended Skills & Agents into one prioritized artifact queue.
- [ ] Add `mapSignalToArtifact(signal)` with tested fixtures.
- [ ] Add artifact rationale: "why this belongs in Custom Instructions / AGENTS.md / skill / agent / script / checklist."
- [ ] Add Prompt Quality Studio with before/after prompt examples.
- [ ] Design Apply Pack export.
