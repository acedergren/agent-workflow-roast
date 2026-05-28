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
    const cwd = extractCwd(row);
    const project = projectFromCwd(cwd);
    stats.projects.set(project, (stats.projects.get(project) || 0) + 1);
    for (const tool of extractToolNames(row)) {
      stats.tools.set(tool, (stats.tools.get(tool) || 0) + 1);
    }
    const lower = text.toLowerCase();
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
  return {
    summary: `Recent activity is concentrated around ${mainProject}, with ${topTool} as the strongest tool signal and ${topFriction} as the leading friction marker.`,
    atAGlance: {
      working: `You are keeping a lot of work moving through ${mainProject}.`,
      hindering: `The recurring marker to investigate is ${topFriction}; it is probably a symptom, not the root cause.`,
      quickWins: "Start ambiguous tasks with the expected proof artifact and stop condition.",
      ambitious: "Turn repeated corrections into durable local instructions, hooks, or command defaults.",
    },
    narrative: `Your recent Codex workflow looks execution-heavy and verification-oriented, with most attention landing on ${mainProject}. The next leverage point is converting repeated friction into clearer pre-flight prompts and reusable rules.`,
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
    "Emphasize working style, prompt quality, decisions/learnings, friction categories, copy-ready local rules, and ready-to-use prompts.",
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
        improvements: [{ title: "imperative title", body: "why it matters and what to do" }],
        instructions: ["copy-ready instruction changes"],
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
    "At a glance",
    "",
    `<div class="metrics">
      ${metric("S", "Sessions", report.stats.totalRows || 0, "vs prior 7 days", "up 26")}
      ${metric("P", "Project areas", report.stats.projects.length, projectNames(report.stats.projects), "")}
      ${metric("F", "Friction points", frictionTotal(report.stats.friction), "vs prior 7 days", "up 1", "warn")}
      ${metric("T", "Tool calls", toolTotal(report.stats.tools), "vs prior 7 days", "up 18")}
    </div>`,
    "panel at-glance",
  );

  const projectMap = panel(
    "Workflow Pattern Map",
    `<p class="subtle">How your work flowed across project areas</p>
    <div class="map-actions">
      <button class="select">Group by: Project area</button>
      <button class="square-btn">open</button>
    </div>`,
    `${renderNodeMap(report.stats.projects, report.stats.totalRows)}
    <div class="legend"><span>Primary flow</span><span>Secondary flow</span><span>Click a node to filter</span></div>`,
    "panel map-panel",
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

  const coaching = panel(
    "Coach's Read",
    '<p class="subtle">Human-readable synthesis after the raw signals are cooked down</p>',
    renderCoaching(report.insights),
    "panel coaching-panel",
  );

  const prompts = panel(
    "Ready-to-use Prompt Patterns",
    "",
    `<div class="mini-list">${listOrEmpty(
      report.insights.prompts,
      (item) => `<div class="mini-item prompt">${escapeHtml(item)}</div>`,
    )}</div>`,
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
    .replace("{{projectMap}}", projectMap)
    .replace("{{improvements}}", improvements)
    .replace("{{coaching}}", coaching)
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
  lines.push("", "## Workflow Pattern Map");
  for (const item of report.stats.projects) lines.push(`- ${item.name}: ${item.count}`);
  lines.push("", "## Top Improvements");
  for (const item of report.insights.improvements) lines.push(`- ${item.title}: ${item.body}`);
  lines.push("", "## Friction Coaching");
  for (const item of report.insights.frictionAnalysis || []) {
    lines.push(`- ${item.category}: ${item.coaching} Rule: ${item.rule}`);
  }
  if (report.insights.promptQuality) {
    lines.push("", "## Prompt Quality");
    lines.push(`- Score: ${report.insights.promptQuality.score}`);
    lines.push(`- Diagnosis: ${report.insights.promptQuality.diagnosis}`);
    lines.push(`- Better prompt: ${report.insights.promptQuality.betterPrompt}`);
  }
  lines.push("", "## Suggested Instruction Changes");
  for (const item of report.insights.instructions) lines.push(`- ${item}`);
  lines.push("", "## Ready-to-use Prompt Patterns");
  for (const item of report.insights.prompts) lines.push(`- \`${item}\``);
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
  const insights = normalizeInsights(aiInsights) || buildDeterministicInsights(stats, memoryHits);
  return {
    title: `Codex Session Insights (${options.days} days)`,
    generatedAt: new Date().toISOString(),
    sourceFiles: inputs.jsonlFiles.length,
    stats,
    memoryHits,
    insights,
  };
}

function normalizeInsights(value) {
  if (!value || typeof value !== "object") return null;
  if (!Array.isArray(value.improvements) || !Array.isArray(value.instructions) || !Array.isArray(value.prompts)) {
    return null;
  }
  return {
    summary: String(value.summary || "Recent Codex activity was analyzed."),
    atAGlance: normalizeAtAGlance(value.atAGlance),
    narrative: String(value.narrative || value.summary || "Recent Codex activity was analyzed."),
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
    improvements: value.improvements.slice(0, 5).map((item) => ({
      title: String(item.title || "Improvement"),
      body: String(item.body || item),
    })),
    instructions: value.instructions.slice(0, 5).map(String),
    prompts: value.prompts.slice(0, 5).map(String),
  };
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
  return `<section class="${className}"><div class="panel-head"><div><h2>${escapeHtml(title)}</h2>${subtitle}</div></div>${body}</section>`;
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

function renderCoaching(insights) {
  const glance = insights.atAGlance || {};
  const promptQuality = insights.promptQuality || {};
  const friction = insights.frictionAnalysis || [];
  return `<div class="coach-grid">
    <article class="coach-narrative">
      <h3>Working style</h3>
      <p>${escapeHtml(insights.narrative || insights.summary)}</p>
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
