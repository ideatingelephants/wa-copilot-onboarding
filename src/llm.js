import { GoogleAuth } from "google-auth-library";
import { config } from "./config.js";

function buildSystemPrompt() {
  const base =
    "You classify WhatsApp group messages for manager intervention. " +
    "Return valid JSON only with this exact shape: " +
    '{"importanceScore":number(0-10),"priority":"low|medium|high|critical","reason":string,"tasks":[{"title":string,"assignee":string|null,"dueHint":string|null,"priority":"low|medium|high"}],"likelyDoneUpdate":boolean}.';

  const context = (config.initialContext || "").trim();
  if (!context) {
    return base;
  }

  return `${base}\nTeam context:\n${context.slice(0, 1400)}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

function stripJsonFence(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  return trimmed
    .replace(/^```[a-zA-Z]*\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
}

function normalizeParsedOutput(parsed) {
  const importanceScore = clamp(Number(parsed?.importanceScore) || 0, 0, 10);
  const priority = ["low", "medium", "high", "critical"].includes(parsed?.priority)
    ? parsed.priority
    : priorityBucket(importanceScore);
  const reason = String(parsed?.reason || "").trim().slice(0, 240);
  const likelyDoneUpdate = Boolean(parsed?.likelyDoneUpdate);

  const tasks = Array.isArray(parsed?.tasks)
    ? parsed.tasks
        .map((task) => ({
          title: String(task?.title || "").trim().slice(0, 180),
          assignee: task?.assignee ? String(task.assignee).trim().slice(0, 60) : null,
          dueHint: task?.dueHint ? String(task.dueHint).trim().slice(0, 80) : null,
          priority: ["low", "medium", "high"].includes(task?.priority) ? task.priority : "medium"
        }))
        .filter((task) => task.title.length > 0)
        .slice(0, 5)
    : [];

  return {
    importanceScore,
    priority,
    reason: reason || "llm",
    tasks,
    likelyDoneUpdate
  };
}

async function requestOpenAI(text) {
  if (!config.openAIKey) {
    return null;
  }

  const payload = {
    model: config.openAIModel,
    input: [
      {
        role: "system",
        content: buildSystemPrompt()
      },
      {
        role: "user",
        content: text.slice(0, 2000)
      }
    ],
    max_output_tokens: 300
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.llmTimeoutMs);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openAIKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      return null;
    }

    const body = await response.json();
    const textOutput = stripJsonFence(body.output_text || "");
    if (!textOutput.startsWith("{")) {
      return null;
    }

    return normalizeParsedOutput(JSON.parse(textOutput));
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

let googleAuthClientPromise = null;

async function getGoogleAuthClient() {
  if (!googleAuthClientPromise) {
    const auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"]
    });
    googleAuthClientPromise = auth.getClient();
  }
  return googleAuthClientPromise;
}

async function getGoogleAccessToken() {
  const client = await getGoogleAuthClient();
  const tokenResult = await client.getAccessToken();
  if (!tokenResult) {
    return "";
  }
  if (typeof tokenResult === "string") {
    return tokenResult;
  }
  if (typeof tokenResult?.token === "string") {
    return tokenResult.token;
  }
  return "";
}

async function requestGeminiVertex(text) {
  if (!config.gcpProjectId) {
    return null;
  }

  let accessToken = "";
  try {
    accessToken = await getGoogleAccessToken();
  } catch {
    return null;
  }

  if (!accessToken) {
    return null;
  }

  const endpoint = `https://${config.gcpLocation}-aiplatform.googleapis.com/v1/projects/${config.gcpProjectId}/locations/${config.gcpLocation}/publishers/google/models/${config.geminiModel}:generateContent`;

  const payload = {
    systemInstruction: {
      parts: [{ text: buildSystemPrompt() }]
    },
    contents: [
      {
        role: "user",
        parts: [{ text: text.slice(0, 2000) }]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 320,
      responseMimeType: "application/json"
    }
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.llmTimeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      return null;
    }

    const body = await response.json();
    const parts = body?.candidates?.[0]?.content?.parts || [];
    const modelText = stripJsonFence(parts.map((part) => String(part?.text || "")).join("\n").trim());
    if (!modelText.startsWith("{")) {
      return null;
    }

    return normalizeParsedOutput(JSON.parse(modelText));
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function classifyWithLLM(text) {
  if (!config.enableLLMClassifier || config.llmProvider === "none") {
    return null;
  }

  if (config.llmProvider === "openai") {
    return requestOpenAI(text);
  }

  if (config.llmProvider === "gemini") {
    return requestGeminiVertex(text);
  }

  return null;
}
