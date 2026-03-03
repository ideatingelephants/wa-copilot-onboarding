import { config } from "./config.js";
import { classifyWithLLM } from "./llm.js";

const PRIORITY_WEIGHTS = new Map([
  ["urgent", 2.2],
  ["asap", 2.2],
  ["immediately", 2.4],
  ["blocker", 2.3],
  ["blocked", 2.1],
  ["delay", 1.3],
  ["escalate", 2.2],
  ["escalation", 2.2],
  ["deadline", 1.8],
  ["today", 1.2],
  ["tonight", 1.2],
  ["tomorrow", 1.1],
  ["critical", 2.6],
  ["important", 1.4],
  ["stuck", 1.6],
  ["approve", 1.2],
  ["approval", 1.2],
  ["review", 1.0],
  ["followup", 1.4],
  ["follow-up", 1.4],
  ["pending", 1.2]
]);

const TASK_HINTS = [
  /\b(todo|action item|action|follow up|follow-up)\b/i,
  /\b(can you|could you|please|need to|kindly)\b/i,
  /\b(assign|assigned|owner|responsible)\b/i
];

const DONE_HINTS = /\b(done|completed|finished|resolved|shipped|closed)\b/i;
const QUESTION_HINT = /\?/;
const DUE_HINT = /\b(by|before|due|eta)\s+([a-z0-9:\/\-\s]{2,35})/i;
const ASSIGNEE_HINT = /@([a-z0-9._-]{2,30})/i;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function tokenize(text) {
  const tokens = (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);

  return Array.from(new Set(tokens)).slice(0, 80);
}

function priorityBucket(score) {
  if (score >= config.criticalPriorityThreshold) {
    return "critical";
  }
  if (score >= config.highPriorityThreshold) {
    return "high";
  }
  if (score >= 2) {
    return "medium";
  }
  return "low";
}

function extractTaskCandidates(text) {
  if (!text) {
    return [];
  }

  const lines = text
    .split(/\n|[.!?]\s+/g)
    .map((line) => line.trim())
    .filter(Boolean);

  const tasks = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/^[-*•]\s*/, "").trim();
    if (!line) {
      continue;
    }
    const looksTasky = TASK_HINTS.some((rx) => rx.test(line));
    if (!looksTasky && line.length < 16) {
      continue;
    }

    const due = line.match(DUE_HINT)?.[2]?.trim() || null;
    const assignee = line.match(ASSIGNEE_HINT)?.[1] || null;
    const priority = /\b(urgent|asap|immediately|blocker|critical)\b/i.test(line) ? "high" : "medium";

    tasks.push({
      title: line.slice(0, 180),
      assignee,
      dueHint: due,
      priority
    });
  }

  return tasks.slice(0, 5);
}

function heuristicAnalyze(text, learnedScores = new Map()) {
  const normalized = (text || "").toLowerCase();
  const tokens = tokenize(normalized);
  const reasons = [];
  let score = 0;

  if (!normalized) {
    return {
      importanceScore: 0,
      priority: "low",
      reason: "empty_text",
      tasks: [],
      likelyDoneUpdate: false
    };
  }

  for (const token of tokens) {
    const keywordWeight = PRIORITY_WEIGHTS.get(token);
    if (keywordWeight) {
      score += keywordWeight;
      reasons.push(`keyword:${token}`);
    }

    const learned = learnedScores.get(token);
    if (Number.isFinite(learned) && learned !== 0) {
      score += learned;
      reasons.push(`learned:${token}`);
    }
  }

  if (QUESTION_HINT.test(text)) {
    score += 0.6;
    reasons.push("question");
  }

  if (/\bneed your input|please check|can we decide|owner\b/i.test(text)) {
    score += 1.4;
    reasons.push("intervention_hint");
  }

  if (/@\d{8,15}/.test(text)) {
    score += 1.1;
    reasons.push("mention");
  }

  score = clamp(score, 0, 10);
  const tasks = extractTaskCandidates(text);
  if (tasks.length > 0) {
    score += 0.8;
    reasons.push("task_detected");
  }
  score = clamp(score, 0, 10);

  return {
    importanceScore: score,
    priority: priorityBucket(score),
    reason: reasons.slice(0, 8).join(", ") || "none",
    tasks,
    likelyDoneUpdate: DONE_HINTS.test(text)
  };
}

export async function analyzeMessage(text, learnedScores = new Map()) {
  const fallback = heuristicAnalyze(text, learnedScores);
  const llm = await classifyWithLLM(text);
  if (!llm) {
    return fallback;
  }

  return {
    importanceScore: llm.importanceScore,
    priority: llm.priority,
    reason: llm.reason || fallback.reason,
    tasks: llm.tasks?.length ? llm.tasks : fallback.tasks,
    likelyDoneUpdate: llm.likelyDoneUpdate
  };
}
