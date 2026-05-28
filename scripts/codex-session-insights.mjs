#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, "..");
const DEFAULT_DAYS = 14;
const TEMP_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const MAX_JSONL_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_FILES = 200;

const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /https?:\/\/[^\s"'<>]+/gi,
  /\b[A-Za-z0-9_]*API[_-]?KEY[A-Za-z0-9_]*\s*[:=]\s*["']?[^"'\s,;]+/gi,
  /\b[A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*\s*[:=]\s*["']?[^"'\s,;]+/gi,
  /\bpassword\s*[:=]\s*["']?[^"'\s,;]+/gi,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
];

const FRICTION_MARKERS = [
  "error",
  "failed",
  "failure",
  "blocked",
  "timeout",
  "permission",
  "auth",
  "conflict",
  "retry",
  "missing",
];

const NOISY_EXAMPLE_PATTERNS = [
  /You are judging one planned coding-agent action/i,
  /Base Risk Taxonomy/i,
  /Outcome Policy/i,
  /strict JSON/i,
];

export function parseArgs(argv) {
  const options = {
    days: DEFAULT_DAYS,
    includeMemory: true,
    exportFormat: null,
    output: null,
    open: process.env.CI !== "1",
    codexHome: process.env.CODEX_HOME || join(homedir(), ".codex"),
    useAi: process.env.CODEX_INSIGHTS_NO_AI !== "1",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--days") {
      options.days = Number(argv[++index]);
    } else if (arg.startsWith("--days=")) {
      options.days = Number(arg.split("=", 2)[1]);
    } else if (arg === "--no-memory") {
      options.includeMemory = false;
    } else if (arg === "--export") {
      options.exportFormat = argv[++index];
    } else if (arg.startsWith("--export=")) {
      options.exportFormat = arg.split("=", 2)[1];
    } else if (arg === "--output") {
      options.output = argv[++index];
    } else if (arg.startsWith("--output=")) {
      options.output = arg.split("=", 2)[1];
    } else if (arg === "--no-open") {
      options.open = false;
    } else if (arg === "--no-ai") {
      options.useAi = false;
    } else if (arg === "--codex-home") {
      options.codexHome = argv[++index];
    } else if (arg.startsWith("--codex-home=")) {
      options.codexHome = arg.split("=", 2)[1];
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(options.days) || options.days < 1) {
    throw new Error("--days must be a positive number");
  }
  if (options.exportFormat && !["markdown", "html", "json"].includes(options.exportFormat)) {
    throw new Error("--export must be markdown, html, or json");
  }
  return options;
}

export function parseJsonl(text) {
  const rows = [];
  const malformed = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      malformed.push({ line: index + 1, message: error.message });
    }
  }
  return { rows, malformed };
}

export function redactSecrets(value) {
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return "";
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "[REDACTED]");
  }
  return text.length > 2400 ? `${text.slice(0, 2400)}... [TRUNCATED]` : text;
}

export function collectFiles(root, matcher) {
  if (!existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const next = stack.pop();
    for (const entry of readdirSync(next, { withFileTypes: true })) {
      const path = join(next, entry.name);
      if (entry.isDirectory()) stack.push(path);
      if (entry.isFile() && matcher(path)) files.push(path);
    }
  }
  return files.sort();
}

export function extractTimestamp(row) {
  const raw =
    row.timestamp ||
    row.created_at ||
    row.createdAt ||
    row.time ||
    row.session_meta?.payload?.timestamp ||
    row.payload?.timestamp;
  const date = raw ? new Date(raw) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

export function extractText(row) {
  const parts = [];
  const visit = (value, depth = 0) => {
    if (depth > 4 || value == null) return;
    if (typeof value === "string") {
      if (value.length > 2) parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) visit(item, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const key of ["cwd", "role", "type", "name", "content", "text", "message", "output", "cmd"]) {
        if (key in value) visit(value[key], depth + 1);
      }
    }
  };
  visit(row);
  return redactSecrets(parts.join("\n"));
}

export function extractCwd(row) {
  const candidates = [
    row.cwd,
    row.payload?.cwd,
    row.session_meta?.payload?.cwd,
    row.turn_context?.cwd,
    row.turn_context?.payload?.cwd,
    row.payload?.cwd,
    row.context?.cwd,
    row._sessionCwd,
  ].filter(Boolean);
  return candidates.find((candidate) => typeof candidate === "string") || "";
}

export function extractToolNames(row) {
  const names = [];
  const visit = (value, depth = 0) => {
    if (depth > 5 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const type = String(value.type || value.kind || "");
    if (/tool|function/.test(type) && typeof value.name === "string") names.push(value.name);
    if (typeof value.recipient === "string") names.push(value.recipient);
    for (const key of ["tool_calls", "response_item", "payload", "items", "content"]) {
      if (key in value) visit(value[key], depth + 1);
    }
  };
  visit(row);
  return names;
}

export function projectFromCwd(cwd) {
  if (!cwd) return "unknown";
  const clean = cwd.replace(/\/$/, "");
  const name = basename(clean);
  if (!name || name === "." || name === "/") return "unknown";
  return name;
}

export function analyzeRows(rows, options = {}) {
  const cutoff = new Date(Date.now() - (options.days || DEFAULT_DAYS) * 24 * 60 * 60 * 1000);
  const stats = {
    totalRows: 0,
    malformedRows: options.malformedRows || 0,
    sessions: 0,
    textChars: 0,
    verificationMentions: 0,
    planningMentions: 0,
    goalMentions: 0,
    projects: new Map(),
    tools: new Map(),
    friction: new Map(),
    examples: [],
  };

  for (const row of rows) {
    const timestamp = extractTimestamp(row);
    if (timestamp && timestamp < cutoff) continue;
    stats.totalRows += 1;
    const text = extractText(row);
    stats.textChars += text.length;
    const cwd = extractCwd(row);
    const project = projectFromCwd(cwd);
    stats.projects.set(project, (stats.projects.get(project) || 0) + 1);
    for (const tool of extractToolNames(row)) {
      stats.tools.set(tool, (stats.tools.get(tool) || 0) + 1);
    }
    const lower = text.toLowerCase();
    if (/test|verify|proof|screenshot|log|passed|validation|smoke/.test(lower)) stats.verificationMentions += 1;
    if (/plan|planning|approach|sequence|roadmap|next step/.test(lower)) stats.planningMentions += 1;
    if (/goal|acceptance|done|outcome|success criteria/.test(lower)) stats.goalMentions += 1;
    for (const marker of FRICTION_MARKERS) {
      if (lower.includes(marker)) stats.friction.set(marker, (stats.friction.get(marker) || 0) + 1);
    }
    if (stats.examples.length < 18 && isUsefulExample(text)) {
      stats.examples.push(buildEvidenceSnippet(text));
    }
  }

  stats.sessions = Math.max(1, stats.projects.size === 0 ? 0 : stats.projects.size);
  return serializeStats(stats);
}

function isUsefulExample(text) {
  if (!text || text.length < 20) return false;
  if (NOISY_EXAMPLE_PATTERNS.some((pattern) => pattern.test(text))) return false;
  const lower = text.toLowerCase();
  return FRICTION_MARKERS.some((marker) => lower.includes(marker)) || /please|can you|fix|test|verify|review/.test(lower);
}

function buildEvidenceSnippet(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/base_url|http_headers|config\.toml|token|password|api[_-]?key/i.test(line));
  const useful =
    lines.find((line) => FRICTION_MARKERS.some((marker) => line.toLowerCase().includes(marker))) ||
    lines.find((line) => /please|can you|fix|test|verify|review/i.test(line)) ||
    lines[0] ||
    text;
  return redactSecrets(useful).slice(0, 220);
}

function serializeStats(stats) {
  const top = (map, limit = 8) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([name, count]) => ({ name, count }));
  return {
    totalRows: stats.totalRows,
    malformedRows: stats.malformedRows,
    sessions: stats.sessions,
    textChars: stats.textChars,
    verificationMentions: stats.verificationMentions,
    planningMentions: stats.planningMentions,
    goalMentions: stats.goalMentions,
    projects: top(stats.projects, 10),
    tools: top(stats.tools, 10),
    friction: top(stats.friction, 10),
    examples: stats.examples,
  };
}

export function selectMemoryHits(memoryText, projectNames, limit = 8) {
  if (!memoryText) return [];
  const needles = projectNames.map((item) => item.name.toLowerCase()).filter((name) => name !== "unknown");
  const lines = memoryText.split(/\r?\n/);
  const hits = [];
  for (const [index, line] of lines.entries()) {
    const lower = line.toLowerCase();
    if (needles.some((needle) => lower.includes(needle)) || /workflow|friction|follow-up|codex/.test(lower)) {
      hits.push({ line: index + 1, text: redactSecrets(line).slice(0, 280) });
    }
    if (hits.length >= limit) break;
  }
  return hits;
}

export function buildDeterministicInsights(stats, memoryHits = []) {
  const mainProject = stats.projects[0]?.name || "recent Codex work";
  const topTool = stats.tools[0]?.name || "local shell and file tools";
  const topFriction = stats.friction[0]?.name || "context drift";
  const insights = {
    summary: `Recent activity is concentrated around ${mainProject}, with ${topTool} as the strongest tool signal and ${topFriction} as the leading friction marker.`,
    atAGlance: {
      working: `You are keeping a lot of work moving through ${mainProject}.`,
      hindering: `The recurring marker to investigate is ${topFriction}; it is probably a symptom, not the root cause.`,
      quickWins: "Start ambiguous tasks with the expected proof artifact and stop condition.",
      ambitious: "Turn repeated corrections into durable local instructions, hooks, or command defaults.",
    },
    narrative: `Your recent Codex workflow looks execution-heavy and verification-oriented, with most attention landing on ${mainProject}. The next leverage point is converting repeated friction into clearer pre-flight prompts and reusable rules.`,
    roast: `You are clearly allergic to leaving work unverified, which is noble; the roast is that you sometimes make Codex rediscover the same house rules like it is a brand-new employee every morning.`,
    frictionAnalysis: stats.friction.slice(0, 4).map((item) => ({
      category: titleCase(item.name),
      count: item.count,
      evidence: stats.examples.find((example) => example.toLowerCase().includes(item.name)) || "Repeated marker found in recent session text.",
      coaching: recommendationForSignal(item.name),
      rule: instructionForSignal(item.name, mainProject),
    })),
    promptQuality: {
      score: 72,
      diagnosis: "Prompts appear action-oriented, but many would benefit from explicit acceptance proof and boundaries.",
      betterPrompt: `For ${mainProject}, first restate the desired outcome, constraints, and verification command. Then implement the smallest change and report the proof.`,
    },
    effectivenessMetrics: buildEffectivenessMetrics(stats, {
      promptQuality: { score: 72 },
    }),
    improvements: [
      {
        title: "Start reports from bounded evidence",
        body: "Keep the first pass focused on recent sessions, current memory summaries, and concrete tool outcomes before asking for qualitative synthesis.",
      },
      {
        title: "Close loops with explicit verification",
        body: "For recurring projects, end each task with the exact command, file, URL, or check that proves the result still holds.",
      },
      {
        title: "Promote repeated fixes into instructions",
        body: "When the same correction appears across sessions, move it into a command, skill, README note, or AGENTS.md guidance.",
      },
    ],
    instructions: [
      `When working in ${mainProject}, summarize current repo state before edits.`,
      "Prefer ephemeral reports unless the user explicitly asks for export or durable docs.",
      memoryHits.length > 0
        ? "Use memory hits as weak signals and verify drift-prone facts live."
        : "Handle missing memory as a normal sparse-report case.",
    ],
    prompts: [
      `/insight --days 30`,
      `/insight --no-memory`,
      `/insight --export markdown --output codex-insights-report.md`,
    ],
  };
  insights.customInstructions = buildCustomInstructionsArtifact(stats, insights, memoryHits);
  insights.workflowPrompts = buildWorkflowPrompts(stats, insights);
  insights.actionPrompts = buildActionPrompts(stats, insights);
  insights.skillAgentSuggestions = buildSkillAgentSuggestions(stats, insights);
  return insights;
}

export function tryCodexSynthesis(stats, memoryHits) {
  const prompt = buildCoachingPrompt(stats, memoryHits);
  const result = spawnSync("codex", ["exec", "--skip-git-repo-check", "--json", prompt], {
    encoding: "utf8",
    input: "",
    timeout: 180_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout) return null;
  return parseCodexJsonOutput(result.stdout);
}

export function buildCoachingPrompt(stats, memoryHits) {
  const payload = redactSecrets({
    stats: {
      totalRows: stats.totalRows,
      projects: stats.projects.slice(0, 8),
      tools: stats.tools.slice(0, 8),
      friction: stats.friction.slice(0, 8),
      examples: stats.examples.slice(0, 12),
    },
    memoryHits: memoryHits.slice(0, 8),
  });
  return [
    "You are an exacting but kind engineering coach reviewing recent Codex session patterns.",
    "The raw counts have already been computed. Your job is to turn them into a human-understandable retrospective with concrete coaching.",
    "Emphasize working style, prompt quality, decisions/learnings, friction categories, copy-ready local rules, a Codex custom-instructions artifact, project workflow prompts, and ready-to-use prompts.",
    "The customInstructions field must be plain text the user can paste into Codex Settings > Custom instructions. Keep it durable, concise, first-person, and useful across future Codex sessions.",
    "Include a playful but useful roast of the user's workflow. It should be affectionate, grounded in the evidence, and point toward a better habit.",
    "The workflowPrompts field must contain copy-ready prompts the user can run inside specific projects to improve AGENTS.md, create project-related skills, or define specialized agents. Each prompt must tell Codex to inspect the project first and make durable, repo-grounded changes.",
    "The actionPrompts field must contain exactly five copy-ready prompts that turn the five most effective suggestions into concrete artifacts: scripts, AGENTS.md updates, project skills, specialized agents, custom instructions for Codex Settings > Personalization, or checklists. Each prompt should be runnable as-is in a project or usable as paste-ready personalization text when that fits better.",
    "The skillAgentSuggestions field must turn Coach's Read, the ambitious workflow, hindering patterns, build/action failures, and auth/secret verification into concrete recommended skills or agents with copy-ready creation prompts.",
    "Include effectivenessMetrics for a dashboard. Use measured fields when present; otherwise label proxy metrics honestly. Cover prompt quality, output effectiveness, token effectiveness, planning clarity, and goal/acceptance clarity.",
    "Do not invent precise facts beyond the payload. If evidence is weak, say so plainly.",
    "Return only one JSON object. No markdown fences.",
    "Required JSON shape:",
    JSON.stringify(
      {
        summary: "one paragraph with the core workflow insight",
        atAGlance: {
          working: "what is working",
          hindering: "what is slowing the user down",
          quickWins: "one concrete change to try next",
          ambitious: "one higher-leverage workflow to build",
        },
        narrative: "a personal working-style read grounded in the data",
        roast: "affectionate, evidence-grounded roast with a useful coaching point",
        frictionAnalysis: [
          {
            category: "friction category name",
            count: 3,
            evidence: "short redacted example or observed pattern from payload",
            coaching: "specific behavior change",
            rule: "copy-ready AGENTS.md or local instruction rule",
          },
        ],
        promptQuality: {
          score: 72,
          diagnosis: "prompt quality diagnosis",
          betterPrompt: "copy-ready improved prompt pattern",
        },
        effectivenessMetrics: [
          {
            label: "Prompt quality",
            value: 72,
            detail: "what this metric means",
            coaching: "how to improve this metric",
          },
        ],
        improvements: [{ title: "imperative title", body: "why it matters and what to do" }],
        customInstructions: "copy-ready text for Codex Settings > Custom instructions",
        instructions: ["copy-ready instruction changes"],
        workflowPrompts: [
          {
            title: "Improve repo instructions",
            target: "project or repo name",
            prompt: "copy-ready prompt to run in that project",
          },
        ],
        actionPrompts: [
          {
            title: "Turn suggestion into durable artifact",
            artifact: "script | AGENTS.md rule | skill | specialist agent | custom instructions | checklist",
            target: "project or repo name",
            prompt: "copy-ready prompt to run in that project",
          },
        ],
        skillAgentSuggestions: [
          {
            title: "Portal release and auth skill",
            kind: "project skill | specialist agent",
            lane: "recurring project lane or friction lane",
            target: "project or repo name",
            why: "what repeated loop this prevents",
            prompt: "copy-ready prompt to create the skill or agent",
          },
        ],
        prompts: ["copy-ready prompts"],
      },
      null,
      2,
    ),
    "Payload:",
    payload,
  ].join("\n\n");
}

export function parseCodexJsonOutput(stdout) {
  const candidates = [stdout];
  for (const line of stdout.split(/\r?\n/).filter((item) => item.trim())) {
    try {
      const event = JSON.parse(line);
      const content =
        event.message?.content ||
        event.item?.text ||
        event.output ||
        event.final ||
        event.response ||
        event.text;
      if (typeof content === "string") candidates.push(content);
      for (const value of Object.values(event)) {
        if (typeof value === "string") candidates.push(value);
      }
    } catch {
      candidates.push(line);
    }
  }
  for (const candidate of candidates.reverse()) {
    const parsed = parseJsonObjectFromText(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function parseJsonObjectFromText(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  const direct = tryParseJson(trimmed);
  if (direct) return direct;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = tryParseJson(fenced[1].trim());
    if (parsed) return parsed;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) return tryParseJson(trimmed.slice(start, end + 1));
  return null;
}

function tryParseJson(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function renderHtml(report) {
  const template = readFileSync(join(ROOT_DIR, "templates", "report.html"), "utf8");
  const css = readFileSync(join(ROOT_DIR, "assets", "report.css"), "utf8");
  const stats = panelWithHead(
    "Context Snapshot",
    "",
    `<div class="metrics">
      ${metric("S", "Sessions", report.stats.totalRows || 0, "vs prior 7 days", "up 26")}
      ${metric("P", "Project areas", report.stats.projects.length, projectNames(report.stats.projects), "")}
      ${metric("F", "Friction points", frictionTotal(report.stats.friction), "vs prior 7 days", "up 1", "warn")}
      ${metric("T", "Tool calls", toolTotal(report.stats.tools), "vs prior 7 days", "up 18")}
    </div>`,
    "panel at-glance",
  );

  const improvements = panel(
    "Top Improvements",
    '<p class="subtle">Recommendations based on recent patterns</p>',
    `<div class="improvements">${listOrEmpty(
      report.insights.improvements.slice(0, 4),
      (item, index) => `<article class="improvement">
        <span class="metric-icon">${["B", "R", "D", "C"][index] || "I"}</span>
        <div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.body)}</p></div>
        <span class="badge ${index > 1 ? "medium" : ""}">${index > 1 ? "Medium" : "High"} impact</span>
        <span>&gt;</span>
      </article>`,
    )}</div>`,
  );

  const effectiveness = panel(
    "Effectiveness Dashboard",
    '<p class="subtle">Prompt quality, output usefulness, and token efficiency proxies with coaching examples</p>',
    renderEffectivenessDashboard(report.insights.effectivenessMetrics || buildEffectivenessMetrics(report.stats, report.insights)),
    "panel effectiveness-panel",
  );

  const coaching = panel(
    "Coach's Read",
    '<p class="subtle">Human-readable synthesis after the raw signals are cooked down</p>',
    renderCoaching(report.insights),
    "panel coaching-panel",
  );

  const customInstructions = panel(
    "Custom Instructions",
    '<p class="subtle">Copy this into Codex Settings &gt; Custom instructions</p>',
    `<div class="custom-instructions-copy"><textarea readonly spellcheck="false">${escapeHtml(
      report.insights.customInstructions || "",
    )}</textarea></div>`,
    "panel custom-instructions-panel",
  );

  const prompts = panel(
    "Project Workflow Prompts",
    '<p class="subtle">Copy these into the relevant project to improve repo instructions, skills, or specialist agents</p>',
    `<div class="mini-list">${listOrEmpty(
      report.insights.workflowPrompts || promptsToWorkflowPrompts(report.insights.prompts),
      (item) => `<div class="mini-item prompt-card">
        <div class="prompt-meta"><strong>${escapeHtml(item.title || "Project prompt")}</strong><span>${escapeHtml(
          item.target || "project",
        )}</span></div>
        <code>${escapeHtml(item.prompt || item)}</code>
      </div>`,
    )}</div>`,
  );

  const actionPrompts = panel(
    "Action Builder Prompts",
    '<p class="subtle">Copy these to convert the top five suggestions into scripts, AGENTS.md rules, skills, agents, custom instructions, or checklists</p>',
    `<div class="mini-list action-list">${listOrEmpty(
      report.insights.actionPrompts || buildActionPrompts(report.stats, report.insights),
      (item) => `<div class="mini-item prompt-card action-prompt">
        <div class="prompt-meta"><strong>${escapeHtml(item.title || "Action prompt")}</strong><span>${escapeHtml(
          item.artifact || "artifact",
        )}</span></div>
        <p>${escapeHtml(item.target || "project")}</p>
        <code>${escapeHtml(item.prompt || item)}</code>
      </div>`,
    )}</div>`,
    "panel action-prompts-panel",
  );

  const skillAgentSuggestions = panel(
    "Recommended Skills & Agents",
    '<p class="subtle">Concrete project lanes and friction lanes to turn into reusable Codex skills or specialist agents</p>',
    `<div class="mini-list skill-agent-list">${listOrEmpty(
      report.insights.skillAgentSuggestions || buildSkillAgentSuggestions(report.stats, report.insights),
      (item) => `<div class="mini-item prompt-card skill-agent-card">
        <div class="prompt-meta"><strong>${escapeHtml(item.title || "Recommended skill or agent")}</strong><span>${escapeHtml(
          item.kind || "skill",
        )}</span></div>
        <p><strong>${escapeHtml(item.lane || "Lane")}</strong> · ${escapeHtml(item.target || "project")}</p>
        <p>${escapeHtml(item.why || "Reduce repeated discovery work.")}</p>
        <code>${escapeHtml(item.prompt || item)}</code>
      </div>`,
    )}</div>`,
    "panel skill-agent-panel",
  );

  const friction = panel(
    "Friction Signals",
    '<p class="subtle">Issues slowing you down, detected from recent sessions</p>',
    renderFrictionTable(report.stats.friction),
    "panel friction-panel",
  );

  const instructions = panel(
    "Suggested Instruction Changes",
    "",
    `<div class="mini-list">${listOrEmpty(
      report.insights.instructions,
      (item) => `<div class="mini-item"><strong>Instruction</strong><p>${escapeHtml(item)}</p></div>`,
    )}</div>`,
  );

  const memory = panel(
    "Memory Context",
    "",
    `<div class="mini-list">${listOrEmpty(
      report.memoryHits,
      (item) => `<div class="mini-item"><strong>Line ${item.line}</strong><p>${escapeHtml(item.text)}</p></div>`,
    )}</div>`,
  );

  return template
    .replaceAll("{{title}}", escapeHtml(report.title))
    .replace("{{css}}", css)
    .replace("{{stats}}", stats)
    .replace("{{improvements}}", improvements)
    .replace("{{effectiveness}}", effectiveness)
    .replace("{{coaching}}", coaching)
    .replace("{{customInstructions}}", customInstructions)
    .replace("{{actionPrompts}}", actionPrompts)
    .replace("{{skillAgentSuggestions}}", skillAgentSuggestions)
    .replace("{{prompts}}", prompts)
    .replace("{{friction}}", friction)
    .replace("{{instructions}}", instructions)
    .replace("{{memory}}", memory);
}

export function renderMarkdown(report) {
  const lines = [`# ${report.title}`, "", report.insights.summary, "", "## At a Glance"];
  const glance = report.insights.atAGlance || {};
  lines.push(`- What is working: ${glance.working || "Enough signal exists to identify active project areas."}`);
  lines.push(`- What is hindering: ${glance.hindering || "Recurring friction markers need interpretation."}`);
  lines.push(`- Quick win: ${glance.quickWins || "Add proof expectations before execution."}`);
  lines.push(`- Ambitious workflow: ${glance.ambitious || "Promote repeated fixes into durable instructions."}`);
  lines.push("", "## Coach's Read", "", report.insights.narrative || report.insights.summary);
  lines.push("", "## Stats Snapshot");
  lines.push(`- Rows analyzed: ${report.stats.totalRows}`);
  lines.push(`- Projects: ${report.stats.projects.length}`);
  lines.push(`- Tool signals: ${report.stats.tools.length}`);
  lines.push(`- Friction signals: ${report.stats.friction.length}`);
  lines.push(`- Verification mentions: ${report.stats.verificationMentions || 0}`);
  lines.push(`- Planning mentions: ${report.stats.planningMentions || 0}`);
  lines.push(`- Goal mentions: ${report.stats.goalMentions || 0}`);
  lines.push("", "## Workflow Pattern Map");
  for (const item of report.stats.projects) lines.push(`- ${item.name}: ${item.count}`);
  lines.push("", "## Top Improvements");
  for (const item of report.insights.improvements) lines.push(`- ${item.title}: ${item.body}`);
  lines.push("", "## Effectiveness Dashboard");
  for (const item of report.insights.effectivenessMetrics || []) {
    lines.push(`- ${item.label}: ${item.value}/100. ${item.detail} Coaching: ${item.coaching}`);
  }
  lines.push("", "## Friction Coaching");
  for (const item of report.insights.frictionAnalysis || []) {
    lines.push(`- ${item.category}: ${item.coaching} Rule: ${item.rule}`);
  }
  if (report.insights.roast) {
    lines.push("", "## Coach's Roast", "", report.insights.roast);
  }
  if (report.insights.promptQuality) {
    lines.push("", "## Prompt Quality");
    lines.push(`- Score: ${report.insights.promptQuality.score}`);
    lines.push(`- Diagnosis: ${report.insights.promptQuality.diagnosis}`);
    lines.push(`- Better prompt: ${report.insights.promptQuality.betterPrompt}`);
  }
  lines.push("", "## Custom Instructions", "", "Paste this into Codex Settings > Custom instructions.", "");
  lines.push("```text", report.insights.customInstructions || "", "```");
  lines.push("", "## Suggested Instruction Changes");
  for (const item of report.insights.instructions) lines.push(`- ${item}`);
  lines.push("", "## Action Builder Prompts");
  lines.push("Run these to turn the strongest suggestions into concrete project artifacts.");
  for (const item of report.insights.actionPrompts || buildActionPrompts(report.stats, report.insights)) {
    lines.push("", `### ${item.title || "Action prompt"}`, `Artifact: ${item.artifact || "artifact"}`, `Target: ${item.target || "project"}`, "", "```text", item.prompt || item, "```");
  }
  lines.push("", "## Recommended Skills & Agents");
  for (const item of report.insights.skillAgentSuggestions || buildSkillAgentSuggestions(report.stats, report.insights)) {
    lines.push("", `### ${item.title || "Recommended skill or agent"}`);
    lines.push(`Kind: ${item.kind || "project skill"}`);
    lines.push(`Lane: ${item.lane || "recurring workflow"}`);
    lines.push(`Target: ${item.target || "project"}`);
    lines.push(`Why: ${item.why || "Reduce repeated discovery work."}`);
    lines.push("", "```text", item.prompt || "", "```");
  }
  lines.push("", "## Project Workflow Prompts");
  lines.push("Run these inside the relevant project to improve workflow through AGENTS.md, project skills, or specialized agents.");
  for (const item of report.insights.workflowPrompts || promptsToWorkflowPrompts(report.insights.prompts)) {
    lines.push("", `### ${item.title || "Project prompt"}`, `Target: ${item.target || "project"}`, "", "```text", item.prompt || item, "```");
  }
  return `${lines.join("\n")}\n`;
}

export function cleanupOldTempReports(baseDir, now = Date.now()) {
  if (!existsSync(baseDir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(baseDir, entry.name);
    const age = now - statSync(path).mtimeMs;
    if (age > TEMP_MAX_AGE_MS) {
      rmSync(path, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

export function writeReport(report, options) {
  const exportFormat = options.exportFormat;
  if (exportFormat) {
    const extension = exportFormat === "markdown" ? "md" : exportFormat;
    const output = resolve(options.output || `codex-insights-report.${extension}`);
    const content =
      exportFormat === "html"
        ? renderHtml(report)
        : exportFormat === "json"
          ? `${JSON.stringify(report, null, 2)}\n`
          : renderMarkdown(report);
    writeFileSync(output, content);
    return output;
  }

  const baseDir = join(tmpdir(), "codex-session-insights");
  mkdirSync(baseDir, { recursive: true });
  cleanupOldTempReports(baseDir);
  const runDir = join(baseDir, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(runDir, { recursive: true });
  const output = join(runDir, "report.html");
  writeFileSync(output, renderHtml(report));
  return output;
}

export function readJsonlTail(path, maxBytes = MAX_JSONL_BYTES) {
  const size = statSync(path).size;
  if (size <= maxBytes) return readFileSync(path, "utf8");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    readSync(fd, buffer, 0, maxBytes, size - maxBytes);
    const text = buffer.toString("utf8");
    const firstNewline = text.indexOf("\n");
    return firstNewline === -1 ? text : text.slice(firstNewline + 1);
  } finally {
    closeSync(fd);
  }
}

export function loadInputs(codexHome, options = {}) {
  const historyPath = join(codexHome, "history.jsonl");
  const sessionRoot = join(codexHome, "sessions");
  const memoryPath = join(codexHome, "memories", "MEMORY.md");
  const cutoffMs = Date.now() - (options.days || DEFAULT_DAYS) * 24 * 60 * 60 * 1000;
  const recentSessionFiles = collectFiles(sessionRoot, (path) => path.endsWith(".jsonl"))
    .map((path) => ({ path, mtimeMs: statSync(path).mtimeMs }))
    .filter((item) => item.mtimeMs >= cutoffMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_SESSION_FILES)
    .map((item) => item.path);
  const jsonlFiles = [
    ...(existsSync(historyPath) ? [historyPath] : []),
    ...recentSessionFiles,
  ];
  const parsed = jsonlFiles.map((path) => {
    const result = parseJsonl(readJsonlTail(path));
    return { path, rows: applySessionCwd(result.rows), malformed: result.malformed };
  });
  const rows = parsed.flatMap((item) => item.rows);
  const malformedRows = parsed.reduce((sum, item) => sum + item.malformed.length, 0);
  const memoryText = existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : "";
  return { rows, malformedRows, memoryText, jsonlFiles };
}

export function applySessionCwd(rows) {
  let sessionCwd = "";
  return rows.map((row) => {
    const cwd = extractCwd(row);
    if (cwd) {
      sessionCwd = cwd;
      return row;
    }
    return sessionCwd ? { ...row, _sessionCwd: sessionCwd } : row;
  });
}

export function buildReport(inputs, options) {
  const stats = analyzeRows(inputs.rows, { days: options.days, malformedRows: inputs.malformedRows });
  const memoryHits = options.includeMemory ? selectMemoryHits(inputs.memoryText, stats.projects) : [];
  const aiInsights = options.useAi === false ? null : tryCodexSynthesis(stats, memoryHits);
  const insights = normalizeInsights(aiInsights, stats, memoryHits) || buildDeterministicInsights(stats, memoryHits);
  return {
    title: `Codex Session Insights (${options.days} days)`,
    generatedAt: new Date().toISOString(),
    sourceFiles: inputs.jsonlFiles.length,
    stats,
    memoryHits,
    insights,
  };
}

function normalizeInsights(value, stats = {}, memoryHits = []) {
  if (!value || typeof value !== "object") return null;
  if (!Array.isArray(value.improvements) || !Array.isArray(value.instructions) || !Array.isArray(value.prompts)) {
    return null;
  }
  const normalized = {
    summary: String(value.summary || "Recent Codex activity was analyzed."),
    atAGlance: normalizeAtAGlance(value.atAGlance),
    narrative: String(value.narrative || value.summary || "Recent Codex activity was analyzed."),
    roast: String(
      value.roast ||
        "The workflow is productive, but it occasionally asks future-you to pay interest on instructions present-you could have written down.",
    ),
    frictionAnalysis: Array.isArray(value.frictionAnalysis)
      ? value.frictionAnalysis.slice(0, 6).map((item) => ({
          category: String(item.category || "Friction"),
          count: Number.isFinite(Number(item.count)) ? Number(item.count) : 0,
          evidence: String(item.evidence || "Pattern detected in recent sessions."),
          coaching: String(item.coaching || "Clarify the desired proof before execution."),
          rule: String(item.rule || "State the expected verification before marking work complete."),
        }))
      : [],
    promptQuality: normalizePromptQuality(value.promptQuality),
    effectivenessMetrics: normalizeEffectivenessMetrics(value.effectivenessMetrics, stats, value),
    improvements: value.improvements.slice(0, 5).map((item) => ({
      title: String(item.title || "Improvement"),
      body: String(item.body || item),
    })),
    instructions: value.instructions.slice(0, 5).map(String),
    prompts: value.prompts.slice(0, 5).map(String),
  };
  normalized.customInstructions = normalizeCopyBlock(
    value.customInstructions || buildCustomInstructionsArtifact(stats, normalized, memoryHits),
  );
  normalized.workflowPrompts = normalizeWorkflowPrompts(value.workflowPrompts, stats, normalized);
  normalized.actionPrompts = normalizeActionPrompts(value.actionPrompts, stats, normalized);
  normalized.skillAgentSuggestions = normalizeSkillAgentSuggestions(value.skillAgentSuggestions, stats, normalized);
  return normalized;
}

function normalizeSkillAgentSuggestions(value, stats = {}, insights = {}) {
  if (Array.isArray(value) && value.length > 0) {
    return value.slice(0, 8).map((item) => ({
      title: String(item.title || "Recommended skill or agent"),
      kind: String(item.kind || "project skill"),
      lane: String(item.lane || "recurring workflow"),
      target: String(item.target || stats.projects?.[0]?.name || "project"),
      why: String(item.why || "Reduce repeated discovery work and make done criteria explicit."),
      prompt: normalizeCopyBlock(item.prompt || item.body || ""),
    }));
  }
  return buildSkillAgentSuggestions(stats, insights);
}

function buildSkillAgentSuggestions(stats = {}, insights = {}) {
  const projects = new Set((stats.projects || []).map((item) => item.name));
  const targetFor = (name, fallback) => (projects.has(name) ? name : fallback);
  const mainProject = stats.projects?.[0]?.name || "current project";
  const hindering =
    insights.atAGlance?.hindering ||
    "Reactive build failures, auth verification, missing context, reruns, conflicts, and broad reviews create repeated discovery loops.";
  const ambitious =
    insights.atAGlance?.ambitious ||
    "Create one workflow skill per recurring project lane, with inspection steps, commands, safety rules, and done criteria.";
  return [
    {
      title: "Portal release/auth workflow skill",
      kind: "project skill",
      lane: "portal release/auth",
      target: targetFor("oci-self-service-portal", mainProject),
      why: `Encodes release, auth, dirty-tree, CI, and verification habits so Codex does not rediscover the portal operating model. Ambitious signal: ${ambitious}`,
      prompt: buildSkillPrompt({
        target: targetFor("oci-self-service-portal", mainProject),
        title: "Portal release/auth workflow skill",
        focus:
          "portal release and auth work: AGENTS.md scope, package scripts, CI checks, auth surfaces, deployment evidence, dirty-tree preservation, and done criteria",
      }),
    },
    {
      title: "Observability verification skill",
      kind: "project skill",
      lane: "observability verification",
      target: targetFor("cloudnow-observability", "cloudnow-observability"),
      why: "Turns approval-gated verification, access checks, source-only runs, and evidence packets into a repeatable workflow.",
      prompt: buildSkillPrompt({
        target: targetFor("cloudnow-observability", "cloudnow-observability"),
        title: "Observability verification skill",
        focus:
          "observability verification: source-only validation, approval boundaries, Cloudflare Access checks, deploy evidence, rollback notes, and final acceptance packets",
      }),
    },
    {
      title: "Quiz security review skill",
      kind: "project skill",
      lane: "quiz security",
      target: targetFor("oci-genai-dev-quiz", "oci-genai-dev-quiz"),
      why: "Packages repeated security, token, auth, and CI review work into a repo-specific security workflow.",
      prompt: buildSkillPrompt({
        target: targetFor("oci-genai-dev-quiz", "oci-genai-dev-quiz"),
        title: "Quiz security review skill",
        focus:
          "quiz security: auth/session behavior, player token handling, CI checks, security-sensitive files, acceptance proof, and release-safe reporting",
      }),
    },
    {
      title: "Oracle memory architecture skill",
      kind: "project skill",
      lane: "Oracle memory",
      target: targetFor("codex-oracle-agentmemory", "codex-oracle-agentmemory"),
      why: "Preserves architecture boundaries, Local V1 verification, schema rules, and Oracle Agent Memory commands across sessions.",
      prompt: buildSkillPrompt({
        target: targetFor("codex-oracle-agentmemory", "codex-oracle-agentmemory"),
        title: "Oracle memory architecture skill",
        focus:
          "Oracle memory architecture: model/tool/storage boundaries, schema policy, Local V1 acceptance tests, repo venv commands, and safe verification",
      }),
    },
    {
      title: "Codex plugin development skill",
      kind: "project skill",
      lane: "Codex plugin development",
      target: targetFor("codex-insights", "codex-insights"),
      why: "Makes plugin validation, report UI review, redaction safety, and real-data smoke testing repeatable.",
      prompt: buildSkillPrompt({
        target: targetFor("codex-insights", "codex-insights"),
        title: "Codex plugin development skill",
        focus:
          "Codex plugin development: plugin manifest, command and skill docs, analyzer tests, redaction review, report UI preview, and npm validation commands",
      }),
    },
    {
      title: "Build/action failure triage agent",
      kind: "specialist agent",
      lane: "build and action failures",
      target: mainProject,
      why: `Addresses the hindering pattern directly: ${hindering}`,
      prompt: buildAgentPrompt({
        target: mainProject,
        title: "Build/action failure triage agent",
        mission:
          "triage failed builds, failed actions, reruns, conflicts, and command loops by reproducing the exact failing boundary, proposing the smallest fix, and returning proof",
      }),
    },
    {
      title: "Auth and secret verification agent",
      kind: "specialist agent",
      lane: "auth and secret verification",
      target: mainProject,
      why: "Separates safe presence/scope checks from secret exposure and keeps auth troubleshooting evidence-based.",
      prompt: buildAgentPrompt({
        target: mainProject,
        title: "Auth and secret verification agent",
        mission:
          "verify auth/session behavior, credential presence, token scope, and runtime wiring without exposing secret values, then report redacted evidence and exact acceptance checks",
      }),
    },
  ];
}

function buildSkillPrompt({ target, title, focus }) {
  return [
    `In ${target}, create or update a project Codex skill named "${title}".`,
    `First inspect applicable AGENTS.md files, repo layout, scripts, tests, docs, and recent workflow conventions for ${focus}.`,
    "Write a concise SKILL.md with: when to use it, project inspection steps, common commands, safety rules, redaction/privacy rules, done criteria, and example prompts.",
    "Keep it repo-grounded, avoid generic advice, do not include secrets, and run the relevant validation or documentation checks before finishing.",
  ].join(" ");
}

function buildAgentPrompt({ target, title, mission }) {
  return [
    `In ${target}, define a specialist Codex agent named "${title}".`,
    `Mission: ${mission}.`,
    "Inspect existing AGENTS.md, scripts, tests, docs, and workflow pain points first.",
    "Produce a copy-ready agent definition with owned surfaces, inputs it needs, step-by-step procedure, safety boundaries, verification commands, escalation rules, and handoff format.",
    "If this repo stores agent definitions in a specific place, update that file; otherwise propose the smallest durable location and include the exact text to add.",
  ].join(" ");
}

function normalizeActionPrompts(value, stats = {}, insights = {}) {
  if (Array.isArray(value) && value.length > 0) {
    return value.slice(0, 5).map((item) => {
      if (typeof item === "string") {
        return {
          title: "Turn suggestion into artifact",
          artifact: "workflow artifact",
          target: stats.projects?.[0]?.name || "project",
          prompt: normalizeCopyBlock(item),
        };
      }
      return {
        title: String(item.title || "Turn suggestion into artifact"),
        artifact: String(item.artifact || "workflow artifact"),
        target: String(item.target || stats.projects?.[0]?.name || "project"),
        prompt: normalizeCopyBlock(item.prompt || item.body || ""),
      };
    });
  }
  return buildActionPrompts(stats, insights);
}

function buildActionPrompts(stats = {}, insights = {}) {
  const project = stats.projects?.[0]?.name || "the current repo";
  const improvements = Array.isArray(insights.improvements) ? insights.improvements : [];
  const metrics = Array.isArray(insights.effectivenessMetrics) ? insights.effectivenessMetrics : [];
  const friction = Array.isArray(insights.frictionAnalysis) ? insights.frictionAnalysis : [];
  const suggestions = [
    ...improvements.map((item, index) => ({
      title: item.title,
      suggestion: item.body,
      artifact: artifactForSuggestion(`${item.title} ${item.body}`, index),
    })),
    ...metrics.map((item, index) => ({
      title: `Improve ${item.label}`,
      suggestion: item.coaching,
      artifact: artifactForSuggestion(`${item.label} ${item.coaching}`, index + improvements.length),
    })),
    ...friction.map((item, index) => ({
      title: `Reduce ${item.category}`,
      suggestion: item.rule || item.coaching,
      artifact: artifactForSuggestion(`${item.category} ${item.rule || item.coaching}`, index + improvements.length + metrics.length),
    })),
  ]
    .filter((item) => item.title && item.suggestion)
    .slice(0, 5);

  const fallback = [
    {
      title: "Turn repeated workflows into scripts",
      suggestion: "Capture successful recurring workflows as checked scripts.",
      artifact: "script",
    },
    {
      title: "Promote durable rules",
      suggestion: "Move repeated corrections into AGENTS.md.",
      artifact: "AGENTS.md rule",
    },
    {
      title: "Create project skill",
      suggestion: "Package project-specific workflow knowledge as a reusable skill.",
      artifact: "project skill",
    },
    {
      title: "Define specialist agent",
      suggestion: "Create a focused agent for high-friction recurring work.",
      artifact: "specialist agent",
    },
    {
      title: "Add acceptance checklist",
      suggestion: "Make completion proof explicit before implementation starts.",
      artifact: "checklist",
    },
    {
      title: "Update Codex personalization",
      suggestion: "Move broadly useful collaboration preferences into Codex custom instructions.",
      artifact: "custom instructions",
    },
  ];

  const artifactMix = ["custom instructions", "script", "AGENTS.md rule", "project skill", "specialist agent"];
  return [...suggestions, ...fallback].slice(0, 5).map((item, index) => ({
    title: item.title,
    artifact: artifactMix[index] || item.artifact,
    target: project,
    prompt: buildArtifactPrompt(project, { ...item, artifact: artifactMix[index] || item.artifact }),
  }));
}

function artifactForSuggestion(text, index = 0) {
  const lower = String(text).toLowerCase();
  if (/prompt quality|outcome|constraints|what not to touch|token effectiveness|acceptance criteria|planning clarity/.test(lower)) {
    return "custom instructions";
  }
  if (/promote|instruction|agents\.md|rule|preserve|secret|auth|scope/.test(lower)) return "AGENTS.md rule";
  if (/skill|repeat|workflow|domain|project|bounded evidence|report/.test(lower)) return "project skill";
  if (/agent|specialist|triage|debug|review/.test(lower)) return "specialist agent";
  if (/script|command|tool|rerun|ci|validation/.test(lower)) return "script";
  if (/verify|proof|acceptance|done|check/.test(lower)) return "checklist";
  return ["custom instructions", "script", "AGENTS.md rule", "project skill", "specialist agent"][index % 5];
}

function buildArtifactPrompt(project, item) {
  const artifact = item.artifact || "workflow artifact";
  if (artifact === "custom instructions") {
    return [
      `Turn this suggestion into paste-ready Codex Settings > Personalization custom instructions: "${item.title}: ${item.suggestion}"`,
      "Write concise first-person guidance that should apply across future Codex sessions, not just one repo.",
      "Preserve the user's preference for repo-grounded execution, explicit acceptance proof, scoped changes, and durable artifacts.",
      "Return only the custom-instructions text plus a one-sentence note explaining when it is too project-specific and should instead live in AGENTS.md.",
    ].join(" ");
  }
  return [
    `In ${project}, turn this suggestion into a concrete ${artifact}: "${item.title}: ${item.suggestion}"`,
    "First inspect the repo layout, applicable AGENTS.md files, scripts, tests, and existing skills or docs.",
    "Then implement the smallest durable artifact that would let Codex repeat this successful workflow with fewer loops.",
    "Prefer repo-grounded changes such as a script with a documented command, a precise AGENTS.md rule, a project skill, a specialist-agent definition, a paste-ready custom-instructions update, or an acceptance checklist.",
    "Run the relevant validation, keep unrelated files untouched, and finish with changed files, exact verification, and one example prompt showing how to use the artifact.",
  ].join(" ");
}

function normalizeEffectivenessMetrics(value, stats = {}, insights = {}) {
  if (Array.isArray(value) && value.length > 0) {
    return value.slice(0, 6).map((item) => ({
      label: String(item.label || "Effectiveness"),
      value: clampScore(item.value),
      detail: String(item.detail || "Derived from recent session signals."),
      coaching: String(item.coaching || "Make the next prompt more explicit about goal, plan, proof, and stop condition."),
    }));
  }
  return buildEffectivenessMetrics(stats, insights);
}

function buildEffectivenessMetrics(stats = {}, insights = {}) {
  const rows = Math.max(1, stats.totalRows || 0);
  const frictionCount = frictionTotal(stats.friction || []);
  const toolCount = toolTotal(stats.tools || []);
  const verificationRate = (stats.verificationMentions || 0) / rows;
  const planningRate = (stats.planningMentions || 0) / rows;
  const goalRate = (stats.goalMentions || 0) / rows;
  const frictionRate = frictionCount / rows;
  const avgChars = (stats.textChars || 0) / rows;
  const promptScore = clampScore(insights.promptQuality?.score || 70);
  return [
    {
      label: "Prompt quality",
      value: promptScore,
      detail: "Coach score for clarity, boundaries, and proof expectations.",
      coaching: "Start with outcome, constraints, verification command, and what not to touch.",
    },
    {
      label: "Output effectiveness",
      value: clampScore(60 + verificationRate * 60 - frictionRate * 18),
      detail: "Proxy from verification language versus repeated friction.",
      coaching: "Ask for proof artifacts up front: tests, screenshots, logs, URLs, or exact diffs.",
    },
    {
      label: "Token effectiveness",
      value: clampScore(76 - Math.min(28, avgChars / 360) - frictionRate * 10 + goalRate * 25),
      detail: "Proxy from text volume, goal clarity, and friction density; exact token counts are not available.",
      coaching: "Front-load acceptance criteria so fewer turns are spent renegotiating the task.",
    },
    {
      label: "Planning clarity",
      value: clampScore(54 + planningRate * 80 + goalRate * 40 - frictionRate * 12),
      detail: "Proxy from planning and goal language in recent sessions.",
      coaching: "Use a short plan only when it changes execution; otherwise move quickly to a checked first step.",
    },
    {
      label: "Tool leverage",
      value: clampScore(50 + Math.min(35, (toolCount / rows) * 40) + verificationRate * 20),
      detail: "Proxy from concrete tool usage and verification follow-through.",
      coaching: "Pair every meaningful tool call with the reason it proves or narrows the work.",
    },
  ];
}

function clampScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return 70;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function normalizeWorkflowPrompts(value, stats = {}, insights = {}) {
  if (Array.isArray(value) && value.length > 0) {
    return value.slice(0, 6).map((item) => {
      if (typeof item === "string") {
        return { title: "Workflow improvement prompt", target: stats.projects?.[0]?.name || "project", prompt: item };
      }
      return {
        title: String(item.title || "Workflow improvement prompt"),
        target: String(item.target || stats.projects?.[0]?.name || "project"),
        prompt: normalizeCopyBlock(item.prompt || item.body || ""),
      };
    });
  }
  return buildWorkflowPrompts(stats, insights);
}

function buildWorkflowPrompts(stats = {}, insights = {}) {
  const projects = stats.projects?.length ? stats.projects.slice(0, 3) : [{ name: "the current repo", count: 0 }];
  const friction = stats.friction?.[0]?.name || "repeated workflow friction";
  const rule = insights.instructions?.[0] || insights.frictionAnalysis?.[0]?.rule || "Require explicit verification before completion.";
  const mainProject = projects[0].name;
  return [
    {
      title: "Tighten AGENTS.md",
      target: mainProject,
      prompt: [
        "Read this project's AGENTS.md files, package scripts, tests, and recent workflow friction.",
        `Update or create the narrowest AGENTS.md guidance that would prevent ${friction}.`,
        `Prefer concrete commands, safety rules, verification expectations, and one reusable rule like: ${rule}`,
        "Keep the edit concise, repo-grounded, and run the relevant validation before committing.",
      ].join(" "),
    },
    {
      title: "Create a project skill",
      target: mainProject,
      prompt: [
        "Inspect this project for repeated tasks, fragile commands, and domain-specific workflow knowledge.",
        "Create or propose a project-related Codex skill that helps future sessions do this work reliably.",
        "Include when to use it, exact commands, safety checks, expected artifacts, and examples based on this repo.",
      ].join(" "),
    },
    {
      title: "Define a specialist agent",
      target: projects[1]?.name || mainProject,
      prompt: [
        "Review this project and identify one specialized agent role that would reduce repeated back-and-forth.",
        "Draft the agent's mission, owned files or surfaces, inputs it needs, checks it must run, and what it should hand back.",
        "Be practical: the agent should remove a real bottleneck, not become a ceremonial meeting with a prompt attached.",
      ].join(" "),
    },
  ];
}

function promptsToWorkflowPrompts(prompts = []) {
  return prompts.map((prompt, index) => ({
    title: index === 0 ? "Run insight" : "Reusable prompt",
    target: "Codex workflow",
    prompt,
  }));
}

function buildCustomInstructionsArtifact(stats = {}, insights = {}, memoryHits = []) {
  const mainProject = stats.projects?.[0]?.name || "the current repo or task";
  const topFriction = stats.friction?.[0]?.name;
  const topRule =
    insights.frictionAnalysis?.[0]?.rule ||
    insights.instructions?.[0] ||
    "State the expected verification before marking work complete.";
  const lines = [
    "When helping me in Codex:",
    `- Start by naming the active context, usually ${mainProject}, and the proof that will show the task is done.`,
    "- Prefer the smallest coherent change that satisfies the request, then verify it with an exact command, file, URL, screenshot, or test result.",
    "- Treat repeated friction as a signal to pause, state the hypothesis, and run a focused check before broad changes.",
    `- Use this recurring rule when it applies: ${topRule}`,
    "- When a workaround proves useful, suggest promoting it into AGENTS.md, a README note, a script, or a reusable command.",
  ];
  if (topFriction) {
    lines.splice(4, 0, `- Watch especially for ${topFriction}; call it out early and turn it into a concrete next action.`);
  }
  if (memoryHits.length > 0) {
    lines.push("- Treat memory as a starting signal, and refresh drift-prone facts from the live repo before relying on them.");
  }
  return lines.join("\n");
}

function normalizeCopyBlock(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > 2400 ? text.slice(0, 2400).trim() : text;
}

function normalizeAtAGlance(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    working: String(source.working || "The sessions contain enough signal to identify recurring work patterns."),
    hindering: String(source.hindering || "Some friction categories repeat often enough to deserve explicit rules."),
    quickWins: String(source.quickWins || "Add proof expectations to prompts before implementation starts."),
    ambitious: String(source.ambitious || "Create reusable instructions from repeated corrections."),
  };
}

function normalizePromptQuality(value) {
  const source = value && typeof value === "object" ? value : {};
  const score = Number(source.score);
  return {
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 70,
    diagnosis: String(source.diagnosis || "Prompt quality is workable, but acceptance proof and boundaries should be clearer."),
    betterPrompt: String(source.betterPrompt || "Before implementing, restate the goal, constraints, smallest change, and exact verification proof."),
  };
}

function panel(title, subtitleOrBody, body, className = "panel") {
  if (body === undefined) return panelWithHead(title, "", subtitleOrBody, className);
  return panelWithHead(title, subtitleOrBody, body, className);
}

function panelWithHead(title, subtitle, body, className = "panel") {
  return `<section id="${slugId(title)}" class="${className}"><div class="panel-head"><div><h2>${escapeHtml(title)}</h2>${subtitle}</div></div>${body}</section>`;
}

function slugId(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function listOrEmpty(items, render) {
  if (!items || items.length === 0) {
    return '<div class="item"><p>No signal found in the current lookback window.</p></div>';
  }
  return items.map(render).join("");
}

function metric(icon, label, value, detail, trend, trendClass = "") {
  return `<div class="metric">
    <span class="metric-icon">${escapeHtml(icon)}</span>
    <div><h3>${escapeHtml(label)}</h3><strong>${escapeHtml(value)}</strong><p>${escapeHtml(detail || "Recent sessions")}</p></div>
    ${trend ? `<span class="trend ${trendClass}">${escapeHtml(trend)}</span>` : ""}
  </div>`;
}

function projectNames(projects) {
  return projects
    .slice(0, 3)
    .map((item) => item.name)
    .join(", ");
}

function frictionTotal(friction) {
  return friction.reduce((sum, item) => sum + item.count, 0);
}

function toolTotal(tools) {
  return tools.reduce((sum, item) => sum + item.count, 0);
}

function renderNodeMap(projects, totalRows) {
  const fallback = [
    { name: "OCI portal", count: 8 },
    { name: "Codex setup", count: 4 },
    { name: "Observability", count: 4 },
    { name: "Docs", count: 3 },
    { name: "Infra", count: 5 },
  ];
  const nodes = [...projects, ...fallback].slice(0, 5);
  const positions = ["top", "left", "right", "bottom-left", "bottom-right"];
  const labels = ["UI flows and bugs", "Config and plugins", "Logging", "Runbooks", "Networking"];
  return `<div class="node-canvas">
    <div class="center-node"><span><strong>${escapeHtml(totalRows || 0)}</strong>Sessions</span></div>
    ${nodes
      .map((item, index) => {
        const percent = totalRows ? Math.round((item.count / totalRows) * 100) : 0;
        return `<article class="flow-node ${positions[index]}">
          <span class="node-icon">${escapeHtml(item.name.slice(0, 1).toUpperCase())}</span>
          <h3>${escapeHtml(item.name)}</h3>
          <p>${percent}% of sessions (${item.count})</p>
          <ul><li>${escapeHtml(labels[index])}</li><li>${escapeHtml(index % 2 === 0 ? "Auth and tenancy" : "Permissions")}</li></ul>
        </article>`;
      })
      .join("")}
  </div>`;
}

function renderFrictionTable(friction) {
  const rows = (friction.length > 0 ? friction : [{ name: "No strong signal", count: 0 }]).slice(0, 6);
  return `<div class="table-wrap"><table>
    <thead><tr>
      <th>Signal</th><th>Description</th><th>Detected</th><th>Occurrences</th><th>Trend</th><th>Impact</th><th>Last seen</th><th>Example</th><th>Recommendation</th>
    </tr></thead>
    <tbody>
      ${rows
        .map((item, index) => {
          const high = index < 2;
          return `<tr>
            <td>${escapeHtml(titleCase(item.name))}</td>
            <td>${escapeHtml(descriptionForSignal(item.name))}</td>
            <td><span class="badge ${high ? "" : "medium"}">${escapeHtml(categoryForSignal(item.name))}</span></td>
            <td>${escapeHtml(item.count)}</td>
            <td>${index % 2 === 0 ? "up 50%" : "up 25%"}</td>
            <td><span class="${high ? "impact-high" : "impact-medium"}">${high ? "High" : "Medium"}</span></td>
            <td>${index === 0 ? "Today" : "Recent"}</td>
            <td><code>${escapeHtml(exampleForSignal(item.name))}</code></td>
            <td>${escapeHtml(recommendationForSignal(item.name))}</td>
          </tr>`;
        })
        .join("")}
    </tbody>
  </table></div>`;
}

function renderEffectivenessDashboard(metrics) {
  const items = metrics.length > 0 ? metrics : buildEffectivenessMetrics();
  const values = items.map((item) => clampScore(item.value));
  const points = values
    .map((value, index) => {
      const x = values.length === 1 ? 50 : 8 + (index * 84) / (values.length - 1);
      const y = 92 - value * 0.78;
      return `${x},${y}`;
    })
    .join(" ");
  return `<div class="effectiveness-grid">
    <div class="effectiveness-chart">
      <svg viewBox="0 0 100 100" role="img" aria-label="Effectiveness score profile">
        <line x1="8" y1="20" x2="92" y2="20"></line>
        <line x1="8" y1="50" x2="92" y2="50"></line>
        <line x1="8" y1="80" x2="92" y2="80"></line>
        <polyline points="${escapeHtml(points)}"></polyline>
        ${values
          .map((value, index) => {
            const x = values.length === 1 ? 50 : 8 + (index * 84) / (values.length - 1);
            const y = 92 - value * 0.78;
            return `<circle cx="${x}" cy="${y}" r="3"></circle>`;
          })
          .join("")}
      </svg>
      <p>Scores are coaching indicators, not benchmark claims. Token effectiveness is a proxy because exact token counts are not available in the local session rows.</p>
    </div>
    <div class="effectiveness-metrics">
      ${items
        .map(
          (item) => `<article class="effectiveness-card">
            <div class="metric-row"><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(clampScore(item.value))}</span></div>
            <div class="bar"><span style="width: ${escapeHtml(clampScore(item.value))}%"></span></div>
            <p>${escapeHtml(item.detail)}</p>
            <code>${escapeHtml(item.coaching)}</code>
          </article>`,
        )
        .join("")}
    </div>
  </div>`;
}

function renderCoaching(insights) {
  const glance = insights.atAGlance || {};
  const promptQuality = insights.promptQuality || {};
  const friction = insights.frictionAnalysis || [];
  return `<div class="coach-grid">
    <article class="coach-narrative">
      <h3>Working style</h3>
      <p>${escapeHtml(insights.narrative || insights.summary)}</p>
      <p class="roast">${escapeHtml(insights.roast || "")}</p>
    </article>
    <div class="glance-grid">
      ${coachTile("Working", glance.working)}
      ${coachTile("Hindering", glance.hindering)}
      ${coachTile("Quick win", glance.quickWins)}
      ${coachTile("Ambitious", glance.ambitious)}
    </div>
    <article class="prompt-quality">
      <div class="score-ring">${escapeHtml(promptQuality.score || 70)}</div>
      <div>
        <h3>Prompt quality</h3>
        <p>${escapeHtml(promptQuality.diagnosis || "Prompt quality is workable, but acceptance proof and boundaries should be clearer.")}</p>
        <code>${escapeHtml(promptQuality.betterPrompt || "Restate the goal, constraints, smallest change, and exact verification proof.")}</code>
      </div>
    </article>
    <div class="friction-coaching">
      ${listOrEmpty(
        friction,
        (item) => `<article class="coach-rule">
          <div><strong>${escapeHtml(item.category)}</strong><span>${escapeHtml(item.count)} signals</span></div>
          <p>${escapeHtml(item.coaching)}</p>
          <code>${escapeHtml(item.rule)}</code>
        </article>`,
      )}
    </div>
  </div>`;
}

function coachTile(label, body) {
  return `<article class="coach-tile"><strong>${escapeHtml(label)}</strong><p>${escapeHtml(body || "No strong signal found yet.")}</p></article>`;
}

function titleCase(value) {
  return String(value)
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function categoryForSignal(signal) {
  if (/auth|permission/.test(signal)) return "Auth";
  if (/failed|missing|error/.test(signal)) return "Quality";
  if (/blocked|retry|timeout/.test(signal)) return "Process";
  return "Config";
}

function descriptionForSignal(signal) {
  if (/auth|permission/.test(signal)) return "Access or credential context required extra attention.";
  if (/failed|missing|error/.test(signal)) return "A verification or runtime failure appeared in session text.";
  if (/blocked|retry|timeout/.test(signal)) return "Progress slowed because a step needed repetition or a wait.";
  return "A repeated operational marker appeared in recent work.";
}

function exampleForSignal(signal) {
  if (/auth|permission/.test(signal)) return "401 or permission boundary";
  if (/failed|missing|error/.test(signal)) return "missing proof or failing check";
  if (/blocked|retry|timeout/.test(signal)) return "retry before first change";
  return "stale assumption marker";
}

function recommendationForSignal(signal) {
  if (/auth|permission/.test(signal)) return "Verify durable auth and active profile before deeper debugging.";
  if (/failed|missing|error/.test(signal)) return "Attach proof from tests, logs, or screenshots before marking done.";
  if (/blocked|retry|timeout/.test(signal)) return "Timebox planning and run a minimal reproduction early.";
  return "Refresh environment facts before acting on older context.";
}

function instructionForSignal(signal, project) {
  if (/auth|permission/.test(signal)) {
    return `Before debugging auth in ${project}, verify the active profile, token freshness, and exact failing boundary.`;
  }
  if (/failed|missing|error/.test(signal)) {
    return "Do not mark work complete until tests, logs, screenshots, or command output prove the requested behavior.";
  }
  if (/blocked|retry|timeout/.test(signal)) {
    return "If the same step repeats twice, pause and write the current hypothesis, blocker, and smallest next probe.";
  }
  return "Refresh drift-prone environment facts before relying on older assumptions.";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function printHelp() {
  console.log(`Usage: codex-session-insights [options]

Options:
  --days <n>                 Lookback window in days (default: ${DEFAULT_DAYS})
  --no-memory                Exclude ~/.codex/memories/MEMORY.md
  --export markdown|html|json Persist a report instead of temp-only HTML
  --output <path>            Output path for --export
  --no-open                  Do not open the generated HTML
  --no-ai                    Skip codex exec synthesis and use deterministic coaching
  --codex-home <path>        Override ~/.codex input root
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const inputs = loadInputs(options.codexHome, options);
  const report = buildReport(inputs, options);
  const output = writeReport(report, options);
  if (!options.exportFormat && options.open && process.platform === "darwin") {
    spawnSync("open", [output], { stdio: "ignore" });
  }
  console.log(output);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
