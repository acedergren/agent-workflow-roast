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
const ESTIMATED_CHARS_PER_TOKEN = 4;
const DEFAULT_ENTERPRISE_INPUT_COST_PER_MILLION = 5;
const DEFAULT_ENTERPRISE_CACHED_INPUT_COST_PER_MILLION = 0.5;
const DEFAULT_ENTERPRISE_OUTPUT_COST_PER_MILLION = 15;

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

function extractTokenUsage(row, text = "") {
  const codexTokenUsage = row?.payload?.type === "token_count" ? row.payload.info?.last_token_usage : null;
  if (codexTokenUsage) return normalizeTokenUsage(codexTokenUsage, true);
  const usage = findUsageObject(row);
  if (usage) return normalizeTokenUsage(usage, true);
  const textUsage = parseTokenUsageText(text);
  if (textUsage) return normalizeTokenUsage(textUsage, true);
  const estimated = Math.max(1, Math.round(String(text || "").length / ESTIMATED_CHARS_PER_TOKEN));
  return {
    input: Math.round(estimated * 0.7),
    cachedInput: 0,
    output: Math.max(0, estimated - Math.round(estimated * 0.7)),
    reasoningOutput: 0,
    total: estimated,
    measured: false,
  };
}

function normalizeTokenUsage(usage, measured) {
  const input = numberFromKeys(usage, [
    "input_tokens",
    "prompt_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ]);
  const cachedInput = numberFromKeys(usage, ["cached_input_tokens", "cache_read_input_tokens", "cachedInputTokens"]);
  const output = numberFromKeys(usage, ["output_tokens", "completion_tokens", "reasoning_output_tokens"]);
  const reasoningOutput = numberFromKeys(usage, ["reasoning_output_tokens", "reasoningOutputTokens"]);
  const totalFromUsage = Number(usage?.total_tokens || usage?.tokens_total || usage?.totalTokens || 0);
  const known = input + output;
  const total = Math.max(totalFromUsage, known);
  const inferredInput = input || Math.round(total * 0.7);
  const inferredOutput = output || Math.max(0, total - inferredInput);
  return {
    input: inferredInput,
    cachedInput: Math.min(cachedInput, inferredInput),
    output: inferredOutput,
    reasoningOutput,
    total,
    measured,
  };
}

function parseTokenUsageText(text) {
  const source = String(text || "");
  const keyValue = source.match(
    /Token usage:\s*total=([\d,.]+[KMB]?)\s+input=([\d,.]+[KMB]?)\s+output=([\d,.]+[KMB]?)(?:\s+cached(?:_input)?=([\d,.]+[KMB]?))?/i,
  );
  if (keyValue) {
    return {
      total_tokens: parseTokenCount(keyValue[1]),
      input_tokens: parseTokenCount(keyValue[2]),
      output_tokens: parseTokenCount(keyValue[3]),
      cached_input_tokens: parseTokenCount(keyValue[4]),
    };
  }
  const prose = source.match(
    /Token usage:\s*([\d,.]+[KMB]?)\s+total\s*\(([\d,.]+[KMB]?)\s+input\s*\+\s*([\d,.]+[KMB]?)\s+output(?:\s*\+\s*([\d,.]+[KMB]?)\s+cached)?/i,
  );
  if (prose) {
    return {
      total_tokens: parseTokenCount(prose[1]),
      input_tokens: parseTokenCount(prose[2]),
      output_tokens: parseTokenCount(prose[3]),
      cached_input_tokens: parseTokenCount(prose[4]),
    };
  }
  return null;
}

function parseTokenCount(value) {
  if (!value) return 0;
  const text = String(value).replace(/,/g, "").trim();
  const match = text.match(/^([\d.]+)\s*([KMB])?$/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;
  const suffix = (match[2] || "").toUpperCase();
  if (suffix === "K") return Math.round(amount * 1_000);
  if (suffix === "M") return Math.round(amount * 1_000_000);
  if (suffix === "B") return Math.round(amount * 1_000_000_000);
  return Math.round(amount);
}

function findUsageObject(value, depth = 0) {
  if (depth > 5 || value == null || typeof value !== "object") return null;
  if (
    ["input_tokens", "cached_input_tokens", "output_tokens", "prompt_tokens", "completion_tokens", "total_tokens", "tokens_total", "totalTokens"].some(
      (key) => Number.isFinite(Number(value[key])),
    )
  ) {
    return value;
  }
  for (const key of ["last_token_usage", "usage", "token_usage", "tokenUsage", "response", "payload", "info", "item", "items", "content"]) {
    const child = value[key];
    if (Array.isArray(child)) {
      for (const item of child.slice(0, 20)) {
        const found = findUsageObject(item, depth + 1);
        if (found) return found;
      }
    } else {
      const found = findUsageObject(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function numberFromKeys(value, keys) {
  if (!value || typeof value !== "object") return 0;
  return keys.reduce((sum, key) => sum + (Number.isFinite(Number(value[key])) ? Number(value[key]) : 0), 0);
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
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
    lookbackDays: options.days || DEFAULT_DAYS,
    sessions: 0,
    textChars: 0,
    verificationMentions: 0,
    planningMentions: 0,
    goalMentions: 0,
    projects: new Map(),
    tools: new Map(),
    friction: new Map(),
    examples: [],
    dailyTokens: new Map(),
    measuredTokens: 0,
    estimatedTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };

  for (const row of rows) {
    const timestamp = extractTimestamp(row);
    if (timestamp && timestamp < cutoff) continue;
    stats.totalRows += 1;
    const text = extractText(row);
    stats.textChars += text.length;
    const tokenUsage = extractTokenUsage(row, text);
    stats.measuredTokens += tokenUsage.measured ? tokenUsage.total : 0;
    stats.estimatedTokens += tokenUsage.measured ? 0 : tokenUsage.total;
    stats.inputTokens += tokenUsage.input;
    stats.cachedInputTokens += tokenUsage.cachedInput;
    stats.outputTokens += tokenUsage.output;
    stats.reasoningOutputTokens += tokenUsage.reasoningOutput;
    const day = dayKey(timestamp || new Date());
    const daily = stats.dailyTokens.get(day) || {
      day,
      input: 0,
      cachedInput: 0,
      output: 0,
      reasoningOutput: 0,
      total: 0,
      measured: 0,
      estimated: 0,
    };
    daily.input += tokenUsage.input;
    daily.cachedInput += tokenUsage.cachedInput;
    daily.output += tokenUsage.output;
    daily.reasoningOutput += tokenUsage.reasoningOutput;
    daily.total += tokenUsage.total;
    if (tokenUsage.measured) daily.measured += tokenUsage.total;
    else daily.estimated += tokenUsage.total;
    stats.dailyTokens.set(day, daily);
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
    lookbackDays: stats.lookbackDays,
    sessions: stats.sessions,
    textChars: stats.textChars,
    tokenSpend: buildTokenSpend(stats),
    verificationMentions: stats.verificationMentions,
    planningMentions: stats.planningMentions,
    goalMentions: stats.goalMentions,
    projects: top(stats.projects, 10),
    tools: top(stats.tools, 10),
    friction: top(stats.friction, 10),
    examples: stats.examples,
  };
}

function buildTokenSpend(stats) {
  const actual = {
    input: Math.round(stats.inputTokens || 0),
    cachedInput: Math.round(stats.cachedInputTokens || 0),
    output: Math.round(stats.outputTokens || 0),
    reasoningOutput: Math.round(stats.reasoningOutputTokens || 0),
    total: Math.round((stats.inputTokens || 0) + (stats.outputTokens || 0)),
  };
  const measured = Math.round(stats.measuredTokens || 0);
  const estimated = Math.round(stats.estimatedTokens || 0);
  const improvementRate = estimateTokenImprovementRate(stats);
  const projected = scaleTokenTotals(actual, 1 - improvementRate);
  const actualCost = estimateEnterpriseCost(actual);
  const projectedCost = estimateEnterpriseCost(projected);
  const dailyRows = fillDailyTokenRows(stats.dailyTokens, stats.lookbackDays || DEFAULT_DAYS);
  const daily = dailyRows
    .map((item) => {
      const itemActual = {
        input: item.input,
        cachedInput: item.cachedInput,
        output: item.output,
        reasoningOutput: item.reasoningOutput,
        total: item.total,
      };
      const itemProjected = scaleTokenTotals(itemActual, 1 - improvementRate);
      return {
        day: item.day,
        actual: Math.round(itemActual.total),
        projected: itemProjected.total,
        measured: Math.round(item.measured),
        estimated: Math.round(item.estimated),
        actualCost: estimateEnterpriseCost(itemActual),
        projectedCost: estimateEnterpriseCost(itemProjected),
      };
    });
  const coverage = {
    startDate: daily[0]?.day || null,
    endDate: daily.at(-1)?.day || null,
    days: daily.length,
  };
  return {
    actual,
    projected,
    measured,
    estimated,
    daily,
    coverage,
    improvementRate,
    actualCost,
    projectedCost,
    savings: {
      tokens: Math.max(0, actual.total - projected.total),
      cost: Math.max(0, actualCost.total - projectedCost.total),
    },
    rates: {
      inputPerMillion: DEFAULT_ENTERPRISE_INPUT_COST_PER_MILLION,
      cachedInputPerMillion: DEFAULT_ENTERPRISE_CACHED_INPUT_COST_PER_MILLION,
      outputPerMillion: DEFAULT_ENTERPRISE_OUTPUT_COST_PER_MILLION,
      currency: "USD",
    },
    caveat:
      measured > 0
        ? "Uses local Codex token-count rows and API usage fields where available; remaining rows are estimated from redacted text volume. This excludes usage only visible in corporate dashboards, Codex Web, or other machines."
        : "No explicit token usage rows were found, so token spend is estimated from redacted text volume. This excludes usage only visible in corporate dashboards, Codex Web, or other machines.",
  };
}

function fillDailyTokenRows(dailyTokens, days) {
  const count = Math.max(1, Math.min(31, Number(days) || DEFAULT_DAYS));
  const rows = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - offset);
    const day = dayKey(date);
    rows.push(
      dailyTokens.get(day) || { day, input: 0, cachedInput: 0, output: 0, reasoningOutput: 0, total: 0, measured: 0, estimated: 0 },
    );
  }
  return rows;
}

function estimateTokenImprovementRate(stats) {
  const rows = Math.max(1, stats.totalRows || 0);
  const frictionRate = frictionTotal([...stats.friction.entries()].map(([name, count]) => ({ name, count }))) / rows;
  const goalRate = (stats.goalMentions || 0) / rows;
  const verificationRate = (stats.verificationMentions || 0) / rows;
  return Math.max(0.08, Math.min(0.35, 0.12 + frictionRate * 0.55 - goalRate * 0.08 - verificationRate * 0.04));
}

function scaleTokenTotals(tokens, factor) {
  return {
    input: Math.round((tokens.input || 0) * factor),
    cachedInput: Math.round((tokens.cachedInput || 0) * factor),
    output: Math.round((tokens.output || 0) * factor),
    reasoningOutput: Math.round((tokens.reasoningOutput || 0) * factor),
    total: Math.round((tokens.total || 0) * factor),
  };
}

function estimateEnterpriseCost(tokens) {
  const cachedInputTokens = Math.min(tokens.cachedInput || 0, tokens.input || 0);
  const uncachedInputTokens = Math.max(0, (tokens.input || 0) - cachedInputTokens);
  const input = (uncachedInputTokens / 1_000_000) * DEFAULT_ENTERPRISE_INPUT_COST_PER_MILLION;
  const cachedInput = (cachedInputTokens / 1_000_000) * DEFAULT_ENTERPRISE_CACHED_INPUT_COST_PER_MILLION;
  const output = ((tokens.output || 0) / 1_000_000) * DEFAULT_ENTERPRISE_OUTPUT_COST_PER_MILLION;
  return {
    input,
    cachedInput,
    output,
    total: input + cachedInput + output,
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
    "The actionPrompts field must contain exactly five copy-ready prompts that turn the five most effective suggestions into concrete artifacts: scripts, AGENTS.md updates, project skills, specialized agents, custom instructions for Codex Settings > Personalization, or checklists. Include a rationale explaining why that artifact type fits.",
    "The skillAgentSuggestions field must turn Coach's Read, the ambitious workflow, hindering patterns, build/action failures, and auth/secret verification into concrete recommended skills or agents with copy-ready creation prompts and artifact rationale.",
    "Include effectivenessMetrics for Coaching Targets. Use measured fields when present; otherwise label proxy metrics honestly. Cover prompt quality, output effectiveness, token effectiveness, planning clarity, and goal/acceptance clarity.",
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
            rationale: "why this belongs in that artifact type",
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
            rationale: "why this should be a skill or agent rather than another artifact",
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

  const coachingHeader = panel(
    "Good / Bad / Ugly",
    '<p class="subtle">The blunt read before the details</p>',
    renderGoodBadUgly(report.insights),
    "panel coaching-strip-panel",
  );

  const effectiveness = panel(
    "Coaching Targets",
    '<p class="subtle">Token spend, estimated enterprise API cost, and coaching metrics mapped to better behavior</p>',
    renderEffectivenessDashboard(
      report.insights.effectivenessMetrics || buildEffectivenessMetrics(report.stats, report.insights),
      report.stats,
    ),
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
    `<div class="custom-instructions-copy">${copyButton(report.insights.customInstructions || "", "Copy instructions")}<textarea readonly spellcheck="false">${escapeHtml(
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
        ${copyButton(item.prompt || item, "Copy prompt")}
        <code>${escapeHtml(item.prompt || item)}</code>
      </div>`,
    )}</div>`,
  );

  const artifactQueue = panel(
    "Create These Artifacts",
    '<p class="subtle">Copy-ready prompts for durable workflow upgrades, with the mapping rationale visible</p>',
    renderArtifactQueue(report.stats, report.insights),
    "panel artifact-queue-panel",
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
      (item) => `<div class="mini-item copyable-item"><div class="copy-row"><strong>Instruction</strong>${copyButton(
        item,
        "Copy instruction",
      )}</div><p>${escapeHtml(item)}</p></div>`,
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
    .replace("{{coachingHeader}}", coachingHeader)
    .replace("{{effectiveness}}", effectiveness)
    .replace("{{coaching}}", coaching)
    .replace("{{customInstructions}}", customInstructions)
    .replace("{{artifactQueue}}", artifactQueue)
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
  lines.push(`- Estimated tokens: ${formatNumber(report.stats.tokenSpend?.actual?.total || 0)}`);
  lines.push(`- Projected tokens after improvements: ${formatNumber(report.stats.tokenSpend?.projected?.total || 0)}`);
  lines.push(`- Estimated enterprise API savings: ${formatCurrency(report.stats.tokenSpend?.savings?.cost || 0)}`);
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
  lines.push("", "## Good / Bad / Ugly");
  lines.push(`- Good: ${glance.working || "Enough signal exists to identify active project areas."}`);
  lines.push(`- Bad: ${glance.hindering || "Recurring friction markers need interpretation."}`);
  lines.push(`- Ugly: ${report.insights.roast || "The recurring loop is costing more than it admits."}`);
  lines.push(`- Next best move: ${(buildArtifactQueue(report.stats, report.insights)[0] || {}).title || "Create one durable workflow artifact."}`);
  lines.push("", "## Coaching Targets");
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
  lines.push("", "## Create These Artifacts");
  lines.push("Run these to turn the strongest suggestions into concrete project artifacts.");
  for (const item of buildArtifactQueue(report.stats, report.insights)) {
    lines.push("", `### ${item.title || "Workflow artifact"}`);
    lines.push(`Artifact: ${item.artifact || "artifact"}`);
    lines.push(`Target: ${item.target || "project"}`);
    lines.push(`Why this artifact: ${item.rationale || "This is the smallest durable place for the workflow rule."}`);
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
    return value.slice(0, 8).map((item) => {
      const mapping = mapSignalToArtifact(
        `${item.title || ""} ${item.kind || ""} ${item.lane || ""} ${item.why || ""}`,
        item.target || stats.projects?.[0]?.name || "project",
      );
      return {
        title: String(item.title || "Recommended skill or agent"),
        kind: String(item.kind || "project skill"),
        lane: String(item.lane || "recurring workflow"),
        target: String(item.target || stats.projects?.[0]?.name || "project"),
        why: String(item.why || "Reduce repeated discovery work and make done criteria explicit."),
        rationale: String(item.rationale || mapping.rationale),
        prompt: normalizeCopyBlock(item.prompt || item.body || ""),
      };
    });
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
      rationale: "Recurring release/auth work needs project-specific inspection steps, commands, safety rules, and done criteria, so it belongs in a skill.",
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
      rationale: "Approval-gated verification is a recurring lane with strict proof rules, so it belongs in a skill rather than a loose prompt.",
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
      rationale: "Security review needs repeatable scope, commands, and redaction rules, so a project skill is the durable artifact.",
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
      rationale: "Architecture boundaries and verification commands are reusable project knowledge, so they belong in a skill.",
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
      rationale: "Plugin development has recurring safety and validation steps, so a project skill keeps future sessions from re-learning them.",
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
      rationale: "Build/action failures are judgment-heavy triage work, so a specialist agent can own reproduction, root cause, and proof.",
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
      rationale: "Auth and secret verification needs strict safety boundaries and evidence discipline, so it fits a specialist agent.",
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
        const mapping = mapSignalToArtifact(item, stats.projects?.[0]?.name || "project");
        return {
          title: "Turn suggestion into artifact",
          artifact: mapping.artifact,
          target: stats.projects?.[0]?.name || "project",
          rationale: mapping.rationale,
          prompt: normalizeCopyBlock(item),
        };
      }
      const mapping = mapSignalToArtifact(`${item.title || ""} ${item.body || item.prompt || ""}`, item.target || stats.projects?.[0]?.name || "project");
      return {
        title: String(item.title || "Turn suggestion into artifact"),
        artifact: String(item.artifact || mapping.artifact),
        target: String(item.target || stats.projects?.[0]?.name || "project"),
        rationale: String(item.rationale || mapping.rationale),
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
      ...mapSignalToArtifact(`${item.title} ${item.body}`, project, index),
    })),
    ...metrics.map((item, index) => ({
      title: `Improve ${item.label}`,
      suggestion: item.coaching,
      ...mapSignalToArtifact(`${item.label} ${item.coaching}`, project, index + improvements.length),
    })),
    ...friction.map((item, index) => ({
      title: `Reduce ${item.category}`,
      suggestion: item.rule || item.coaching,
      ...mapSignalToArtifact(`${item.category} ${item.rule || item.coaching}`, project, index + improvements.length + metrics.length),
    })),
  ]
    .filter((item) => item.title && item.suggestion)
    .slice(0, 5);

  const fallback = [
    {
      title: "Turn repeated workflows into scripts",
      suggestion: "Capture successful recurring workflows as checked scripts.",
      artifact: "script",
      rationale: "Repeated command sequences belong in scripts so future sessions can run one known path instead of rediscovering it.",
    },
    {
      title: "Promote durable rules",
      suggestion: "Move repeated corrections into AGENTS.md.",
      artifact: "AGENTS.md rule",
      rationale: "Repo-specific behavior belongs in AGENTS.md because it should travel with this project.",
    },
    {
      title: "Create project skill",
      suggestion: "Package project-specific workflow knowledge as a reusable skill.",
      artifact: "project skill",
      rationale: "Recurring project lanes belong in skills because they need trigger rules, inspection steps, commands, and done criteria.",
    },
    {
      title: "Define specialist agent",
      suggestion: "Create a focused agent for high-friction recurring work.",
      artifact: "specialist agent",
      rationale: "Judgment-heavy triage belongs in a specialist agent because it needs scoped ownership and a repeatable handoff.",
    },
    {
      title: "Add acceptance checklist",
      suggestion: "Make completion proof explicit before implementation starts.",
      artifact: "checklist",
      rationale: "Completion ambiguity belongs in a checklist because done criteria must be visible before execution starts.",
    },
    {
      title: "Update Codex personalization",
      suggestion: "Move broadly useful collaboration preferences into Codex custom instructions.",
      artifact: "custom instructions",
      rationale: "Global working preferences belong in Codex custom instructions because they should apply across repositories.",
    },
  ];

  const artifactMix = ["custom instructions", "script", "AGENTS.md rule", "project skill", "specialist agent"];
  return [...suggestions, ...fallback].slice(0, 5).map((item, index) => ({
    title: item.title,
    artifact: artifactMix[index] || item.artifact,
    target: project,
    rationale: item.rationale || mapSignalToArtifact(`${item.title} ${item.suggestion}`, project, index).rationale,
    prompt: buildArtifactPrompt(project, { ...item, artifact: artifactMix[index] || item.artifact }),
  }));
}

function artifactForSuggestion(text, index = 0) {
  return mapSignalToArtifact(text, "project", index).artifact;
}

export function mapSignalToArtifact(text, target = "project", index = 0) {
  const lower = String(text).toLowerCase();
  if (/prompt quality|outcome|constraints|what not to touch|token effectiveness|planning clarity/.test(lower)) {
    return {
      artifact: "custom instructions",
      rationale: "This is a global collaboration preference, so it belongs in Codex personalization instead of one repo.",
    };
  }
  if (/promote|instruction|agents\.md|rule|preserve|secret|auth|scope/.test(lower)) {
    return {
      artifact: "AGENTS.md rule",
      rationale: `This is repo-specific operating guidance for ${target}, so it should live where future agents will read it before editing.`,
    };
  }
  if (/skill|repeat|workflow|domain|project|bounded evidence|report|lane/.test(lower)) {
    return {
      artifact: "project skill",
      rationale: "This is a recurring workflow lane, so it needs trigger rules, inspection steps, commands, and done criteria.",
    };
  }
  if (/agent|specialist|triage|debug|review/.test(lower)) {
    return {
      artifact: "specialist agent",
      rationale: "This is judgment-heavy recurring work, so a scoped specialist agent can own the investigation and handoff.",
    };
  }
  if (/script|command|tool|rerun|ci|validation/.test(lower)) {
    return {
      artifact: "script",
      rationale: "This is a repeatable command sequence, so a script reduces token-heavy rediscovery and copy/paste drift.",
    };
  }
  if (/verify|proof|acceptance|done|check/.test(lower)) {
    return {
      artifact: "checklist",
      rationale: "This is a done-criteria problem, so a checklist makes acceptance proof explicit before work starts.",
    };
  }
  const fallback = [
    ["custom instructions", "This looks like a broad collaboration preference, so start with Codex personalization."],
    ["script", "This can likely become a repeatable command path with less future narration."],
    ["AGENTS.md rule", `This likely belongs near ${target} because future agents need the rule before touching files.`],
    ["project skill", "This looks like reusable project knowledge that deserves a triggerable workflow."],
    ["specialist agent", "This may need a focused agent if it recurs with judgment-heavy branching."],
  ][index % 5];
  return { artifact: fallback[0], rationale: fallback[1] };
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

function buildArtifactQueue(stats = {}, insights = {}) {
  const actionPrompts = normalizeActionPrompts(insights.actionPrompts, stats, insights);
  const skillAgents = normalizeSkillAgentSuggestions(insights.skillAgentSuggestions, stats, insights);
  const seen = new Set();
  return [...actionPrompts, ...skillAgents]
    .map((item) => {
      const artifact = item.artifact || item.kind || mapSignalToArtifact(`${item.title || ""} ${item.why || ""}`).artifact;
      const target = item.target || stats.projects?.[0]?.name || "project";
      const mapping = mapSignalToArtifact(`${item.title || ""} ${artifact} ${item.why || item.prompt || ""}`, target);
      return {
        title: item.title || "Workflow artifact",
        artifact,
        target,
        rationale: item.rationale || mapping.rationale,
        prompt: item.prompt || "",
      };
    })
    .filter((item) => {
      const key = `${item.title}:${item.artifact}:${item.target}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return item.prompt;
    })
    .slice(0, 7);
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

function renderGoodBadUgly(insights) {
  const glance = insights.atAGlance || {};
  return `<div class="gbu-grid">
    ${coachSignal("Good", glance.working || "Recurring project patterns are visible enough to improve.", "Keep")}
    ${coachSignal("Bad", glance.hindering || "Reactive loops and missing proof are costing time.", "Fix")}
    ${coachSignal(
      "Ugly",
      insights.roast || "The workflow is productive, but it keeps making future-you pay interest on unwritten rules.",
      "Roast",
    )}
    ${coachSignal("Next best move", (buildArtifactQueue({}, insights)[0] || {}).title || "Create one durable workflow artifact.", "Do first")}
  </div>`;
}

function coachSignal(label, body, badge) {
  return `<article class="gbu-card">
    <span>${escapeHtml(badge)}</span>
    <strong>${escapeHtml(label)}</strong>
    <p>${escapeHtml(body)}</p>
  </article>`;
}

function copyButton(value, label = "Copy") {
  return `<button type="button" class="copy-button" data-copy-text="${escapeHtml(value || "")}" aria-label="${escapeHtml(label)}">${escapeHtml(label)}</button>`;
}

function renderArtifactQueue(stats, insights) {
  return `<div class="artifact-list">${listOrEmpty(
    buildArtifactQueue(stats, insights),
    (item, index) => `<article class="artifact-card">
      <div class="artifact-topline">
        <span class="artifact-priority">P${escapeHtml(index + 1)}</span>
        <span class="artifact-badge">${escapeHtml(item.artifact || "artifact")}</span>
      </div>
      <h3>${escapeHtml(item.title || "Workflow artifact")}</h3>
      <p><strong>Target:</strong> ${escapeHtml(item.target || "project")}</p>
      <p><strong>Why this artifact:</strong> ${escapeHtml(item.rationale || "This is the smallest durable place for the workflow rule.")}</p>
      ${copyButton(item.prompt || "", "Copy prompt")}
      <code>${escapeHtml(item.prompt || "")}</code>
    </article>`,
  )}</div>`;
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

function renderEffectivenessDashboard(metrics, stats = {}) {
  const items = metrics.length > 0 ? metrics : buildEffectivenessMetrics();
  const tokenSpend = stats.tokenSpend || buildEmptyTokenSpend();
  return `<div class="effectiveness-grid">
    <div class="effectiveness-chart">
      <div class="spend-summary">
        <div><span>Actual est.</span><strong>${escapeHtml(formatNumber(tokenSpend.actual.total))}</strong><small>tokens</small></div>
        <div><span>Improved scenario</span><strong>${escapeHtml(formatNumber(tokenSpend.projected.total))}</strong><small>tokens</small></div>
        <div><span>API cost delta</span><strong>${escapeHtml(formatCurrency(tokenSpend.savings.cost))}</strong><small>saved</small></div>
      </div>
      <div class="spend-coverage">
        <span><strong>Dates:</strong> ${escapeHtml(formatDateRange(tokenSpend.coverage))}</span>
        <span><strong>Measured:</strong> ${escapeHtml(formatNumber(tokenSpend.measured || 0))} tokens</span>
        <span><strong>Estimated fallback:</strong> ${escapeHtml(formatNumber(tokenSpend.estimated || 0))} tokens</span>
      </div>
      ${renderTokenSpendChart(tokenSpend)}
      <p>${escapeHtml(tokenSpend.caveat)} Scenario assumes ${escapeHtml(Math.round(tokenSpend.improvementRate * 100))}% token reduction from applying the recommended artifacts. Cost uses ${escapeHtml(formatCurrency(tokenSpend.rates.inputPerMillion))}/1M input, ${escapeHtml(formatCurrency(tokenSpend.rates.cachedInputPerMillion))}/1M cached input, and ${escapeHtml(formatCurrency(tokenSpend.rates.outputPerMillion))}/1M output tokens.</p>
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

function renderTokenSpendChart(tokenSpend) {
  const daily = tokenSpend.daily.length > 0 ? tokenSpend.daily : [{ day: "No data", actual: 0, projected: 0, actualCost: { total: 0 }, projectedCost: { total: 0 } }];
  const max = Math.max(1, ...daily.flatMap((item) => [item.actual, item.projected]));
  const chartWidth = 720;
  const chartHeight = 240;
  const plotTop = 24;
  const plotBottom = 184;
  const slot = chartWidth / daily.length;
  const barWidth = Math.min(28, Math.max(10, slot * 0.22));
  const y = (value) => plotBottom - (value / max) * (plotBottom - plotTop);
  const pointsFor = (key) =>
    daily
      .map((item, index) => {
        const x = slot * index + slot / 2;
        return `${x.toFixed(1)},${y(item[key]).toFixed(1)}`;
      })
      .join(" ");
  const labels = daily
    .map((item, index) => {
      const x = slot * index + slot / 2;
      return `<text x="${escapeHtml(x.toFixed(1))}" y="218">${escapeHtml(shortDay(item.day))}</text>`;
    })
    .join("");
  const bars = daily
    .map((item, index) => {
      const x = slot * index + slot / 2;
      const actualY = y(item.actual);
      const projectedY = y(item.projected);
      return `<g>
        <rect class="actual-token-bar" x="${escapeHtml((x - barWidth - 2).toFixed(1))}" y="${escapeHtml(actualY.toFixed(1))}" width="${escapeHtml(barWidth.toFixed(1))}" height="${escapeHtml((plotBottom - actualY).toFixed(1))}"></rect>
        <rect class="projected-token-bar" x="${escapeHtml((x + 2).toFixed(1))}" y="${escapeHtml(projectedY.toFixed(1))}" width="${escapeHtml(barWidth.toFixed(1))}" height="${escapeHtml((plotBottom - projectedY).toFixed(1))}"></rect>
      </g>`;
    })
    .join("");
  const lookbackDays = daily.length;
  const dateRange = formatDateRange(tokenSpend.coverage);
  return `<figure class="token-spend-chart">
    <figcaption>
      <strong>${escapeHtml(lookbackDays)}-day token spend scenario</strong>
      <em>${escapeHtml(dateRange)}</em>
      <span>${escapeHtml(formatCurrency(tokenSpend.actualCost.total))} actual est. vs ${escapeHtml(formatCurrency(tokenSpend.projectedCost.total))} if improvements land</span>
    </figcaption>
    <svg viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-label="Estimated token spend by day compared with improved scenario">
      <line x1="0" y1="${plotTop}" x2="${chartWidth}" y2="${plotTop}"></line>
      <line x1="0" y1="${(plotTop + plotBottom) / 2}" x2="${chartWidth}" y2="${(plotTop + plotBottom) / 2}"></line>
      <line x1="0" y1="${plotBottom}" x2="${chartWidth}" y2="${plotBottom}"></line>
      ${bars}
      <polyline class="actual-token-line" points="${escapeHtml(pointsFor("actual"))}"></polyline>
      <polyline class="projected-token-line" points="${escapeHtml(pointsFor("projected"))}"></polyline>
      ${labels}
    </svg>
    <div class="chart-legend">
      <span><i class="actual-key"></i>Actual estimated tokens</span>
      <span><i class="projected-key"></i>After workflow improvements</span>
    </div>
  </figure>`;
}

function buildEmptyTokenSpend() {
  return {
    actual: { input: 0, output: 0, total: 0 },
    projected: { input: 0, cachedInput: 0, output: 0, total: 0 },
    daily: [],
    measured: 0,
    estimated: 0,
    coverage: { startDate: null, endDate: null, days: 0 },
    improvementRate: 0,
    actualCost: { total: 0 },
    projectedCost: { total: 0 },
    savings: { tokens: 0, cost: 0 },
    rates: {
      inputPerMillion: DEFAULT_ENTERPRISE_INPUT_COST_PER_MILLION,
      cachedInputPerMillion: DEFAULT_ENTERPRISE_CACHED_INPUT_COST_PER_MILLION,
      outputPerMillion: DEFAULT_ENTERPRISE_OUTPUT_COST_PER_MILLION,
    },
    caveat: "No token spend signal found.",
  };
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(Number(value) || 0));
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(Number(value) || 0);
}

function shortDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return value;
  const date = new Date(`${value}T00:00:00Z`);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function formatDateRange(coverage = {}) {
  if (!coverage.startDate || !coverage.endDate) return "No dated local token rows";
  if (coverage.startDate === coverage.endDate) return longDate(coverage.startDate);
  return `${longDate(coverage.startDate)} - ${longDate(coverage.endDate)}`;
}

function longDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return value;
  const date = new Date(`${value}T00:00:00Z`);
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
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
