import dotenv from "dotenv";

dotenv.config();

function toInt(name, fallback) {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function toFloat(name, fallback) {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") {
    return fallback;
  }

  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

function toBool(name, fallback = false) {
  const raw = (process.env[name] || "").trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  return ["1", "true", "yes", "y", "on"].includes(raw);
}

function onlyDigits(value) {
  return (value || "").replace(/[^\d]/g, "");
}

export function normalizeJid(value) {
  const raw = (value || "").trim();
  if (!raw) {
    return "";
  }
  if (raw.endsWith("@g.us")) {
    return raw;
  }
  if (/^\d+$/.test(raw)) {
    return `${raw}@s.whatsapp.net`;
  }
  if (raw.includes("@")) {
    const [left, right] = raw.split("@");
    const deviceSafeLeft = left.split(":")[0];
    return `${deviceSafeLeft}@${right}`;
  }

  const digits = onlyDigits(raw);
  if (digits) {
    return `${digits}@s.whatsapp.net`;
  }

  return raw;
}

function ownerJidFromEnv() {
  const explicitJid = normalizeJid(process.env.OWNER_JID || "");
  if (explicitJid) {
    return explicitJid;
  }

  const phone = onlyDigits(process.env.OWNER_PHONE || "");
  if (phone) {
    return `${phone}@s.whatsapp.net`;
  }

  return "";
}

function detectLLMProvider() {
  const enabled = toBool("ENABLE_LLM_CLASSIFIER", false);
  if (!enabled) {
    return "none";
  }

  const raw = (process.env.LLM_PROVIDER || "").trim().toLowerCase();
  if (["openai", "gemini"].includes(raw)) {
    return raw;
  }

  if (process.env.GCP_PROJECT_ID) {
    return "gemini";
  }
  if (process.env.OPENAI_API_KEY) {
    return "openai";
  }
  return "gemini";
}

export const config = {
  databaseUrl: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/wa_ops_copilot",
  ownerJid: ownerJidFromEnv(),
  initialContext: (process.env.INITIAL_CONTEXT || "").trim().slice(0, 2000),
  botPhone: onlyDigits(process.env.BOT_PHONE || ""),
  authDir: process.env.AUTH_DIR || "./auth",
  logLevel: process.env.LOG_LEVEL || "info",
  timezone: process.env.TIMEZONE || "Asia/Kolkata",
  analyzeIntervalMs: toInt("ANALYZE_INTERVAL_MS", 60_000),
  analyzeBatchSize: toInt("ANALYZE_BATCH_SIZE", 120),
  nudgeIntervalMs: toInt("NUDGE_INTERVAL_MS", 120_000),
  highPriorityThreshold: toFloat("HIGH_PRIORITY_THRESHOLD", 3.5),
  criticalPriorityThreshold: toFloat("CRITICAL_PRIORITY_THRESHOLD", 6),
  maxNudgesPerTick: toInt("MAX_NUDGES_PER_TICK", 5),
  maxTaskNudgesPerTick: toInt("MAX_TASK_NUDGES_PER_TICK", 5),
  staleTaskHours: toInt("STALE_TASK_HOURS", 8),
  digestIntervalMinutes: toInt("DIGEST_INTERVAL_MINUTES", 240),
  digestLookbackHours: toInt("DIGEST_LOOKBACK_HOURS", 24),
  quietHoursStart: toInt("QUIET_HOURS_START", 23),
  quietHoursEnd: toInt("QUIET_HOURS_END", 7),
  enableLLMClassifier: toBool("ENABLE_LLM_CLASSIFIER", false),
  llmProvider: detectLLMProvider(),
  llmTimeoutMs: toInt("LLM_TIMEOUT_MS", 20_000),
  openAIKey: process.env.OPENAI_API_KEY || "",
  openAIModel: process.env.OPENAI_MODEL || "gpt-5-mini",
  gcpProjectId: process.env.GCP_PROJECT_ID || "",
  gcpLocation: process.env.GCP_LOCATION || "us-central1",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.0-flash-001"
};

export function assertConfig() {
  if (!config.ownerJid) {
    throw new Error("Missing owner identity. Set OWNER_JID or OWNER_PHONE in .env.");
  }

  if (config.enableLLMClassifier && config.llmProvider === "openai" && !config.openAIKey) {
    throw new Error("ENABLE_LLM_CLASSIFIER=1 and LLM_PROVIDER=openai require OPENAI_API_KEY.");
  }

  if (config.enableLLMClassifier && config.llmProvider === "gemini" && !config.gcpProjectId) {
    throw new Error("ENABLE_LLM_CLASSIFIER=1 and LLM_PROVIDER=gemini require GCP_PROJECT_ID.");
  }
}
