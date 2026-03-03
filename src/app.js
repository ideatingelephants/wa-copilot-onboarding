import fs from "node:fs/promises";
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import { analyzeMessage, tokenize } from "./analysis.js";
import { handleOwnerCommand } from "./commands.js";
import { assertConfig, config, normalizeJid } from "./config.js";
import { closeDb, initSchema } from "./db.js";
import { extractTextFromMessage, toDateFromMessageTimestamp } from "./messages.js";
import { formatDigest, formatTaskNudge, formatUrgentNudge, isQuietHours, sendText } from "./notifier.js";
import {
  addNudgeLog,
  fetchStaleOpenTasks,
  fetchUrgentUnnudgedMessages,
  getDigestSummary,
  getKeywordScores,
  getLastDigestAt,
  getPausedState,
  insertTasksFromMessage,
  listUnprocessedWatchedMessages,
  markMessageAnalysis,
  markMessageNudged,
  markTaskNudged,
  saveIncomingMessage,
  setLastDigestAt
} from "./store.js";

const logger = pino({ level: config.logLevel });

const runtime = {
  sock: null,
  connected: false,
  shutdown: false,
  analysisTickActive: false,
  nudgeTickActive: false,
  digestTickActive: false
};

function isGroupJid(jid) {
  return (jid || "").endsWith("@g.us");
}

async function ensureAuthDir() {
  await fs.mkdir(config.authDir, { recursive: true });
}

async function connectWhatsApp() {
  await ensureAuthDir();

  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: true,
    logger: logger.child({ scope: "baileys" }),
    browser: ["WA Ops Copilot", "Desktop", "0.1.0"],
    syncFullHistory: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      runtime.sock = sock;
      runtime.connected = true;
      logger.info("WhatsApp connected");
      return;
    }

    if (connection === "close") {
      runtime.connected = false;

      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && !runtime.shutdown;

      logger.warn({ statusCode }, "WhatsApp connection closed");

      if (shouldReconnect) {
        setTimeout(() => {
          connectWhatsApp().catch((err) => logger.error({ err }, "Reconnect failed"));
        }, 4_000);
      } else {
        logger.error("Logged out. Delete auth directory and pair again.");
      }
    }
  });

  sock.ev.on("messages.upsert", async (event) => {
    const messages = event?.messages || [];
    for (const m of messages) {
      try {
        await handleIncomingMessage(sock, m);
      } catch (err) {
        logger.error({ err }, "Failed to process incoming message");
      }
    }
  });
}

async function handleIncomingMessage(sock, m) {
  const key = m?.key;
  if (!key?.id || !key.remoteJid) {
    return;
  }
  if (key.remoteJid === "status@broadcast") {
    return;
  }

  const chatJid = normalizeJid(key.remoteJid);
  const groupJid = isGroupJid(chatJid) ? chatJid : null;
  const senderJid = normalizeJid(isGroupJid(chatJid) ? key.participant || m.participant || "" : chatJid);
  const text = extractTextFromMessage(m.message);
  const sentAt = toDateFromMessageTimestamp(m.messageTimestamp);

  const inserted = await saveIncomingMessage({
    messageId: key.id,
    chatJid,
    groupJid,
    senderJid,
    fromMe: Boolean(key.fromMe),
    sentAt,
    textContent: text,
    rawPayload: m
  });

  if (!inserted) {
    return;
  }

  if (text.startsWith("/")) {
    await handleOwnerCommand({
      sock,
      chatJid,
      isGroup: Boolean(groupJid),
      senderJid,
      text
    });
  }
}

async function runAnalysisTick() {
  if (runtime.analysisTickActive) {
    return;
  }
  runtime.analysisTickActive = true;

  try {
    if (await getPausedState()) {
      return;
    }

    const rows = await listUnprocessedWatchedMessages(config.analyzeBatchSize);
    if (rows.length === 0) {
      return;
    }

    for (const row of rows) {
      const text = row.text_content || "";
      const tokens = tokenize(text);
      const learnedScores = await getKeywordScores(tokens);
      const analysis = await analyzeMessage(text, learnedScores);

      await markMessageAnalysis(row.message_id, analysis);

      if (analysis.tasks.length > 0 && row.group_jid) {
        await insertTasksFromMessage(row.group_jid, row.message_id, analysis.tasks);
      }
    }
  } catch (err) {
    logger.error({ err }, "Analysis tick failed");
  } finally {
    runtime.analysisTickActive = false;
  }
}

function shouldSendByQuietHours(priorityScore) {
  if (!isQuietHours()) {
    return true;
  }
  return Number(priorityScore || 0) >= config.criticalPriorityThreshold;
}

async function runNudgeTick() {
  if (runtime.nudgeTickActive) {
    return;
  }
  runtime.nudgeTickActive = true;

  try {
    if (!runtime.connected || !runtime.sock) {
      return;
    }
    if (await getPausedState()) {
      return;
    }

    const urgent = await fetchUrgentUnnudgedMessages(config.highPriorityThreshold, config.maxNudgesPerTick);
    for (const row of urgent) {
      if (!shouldSendByQuietHours(row.importance_score)) {
        continue;
      }

      await sendText(runtime.sock, config.ownerJid, formatUrgentNudge(row));
      await markMessageNudged(row.message_id);
      await addNudgeLog({
        nudgeType: "important_message",
        targetJid: config.ownerJid,
        messageId: row.message_id,
        payload: {
          groupJid: row.group_jid,
          score: row.importance_score
        }
      });
    }

    const staleTasks = await fetchStaleOpenTasks(config.staleTaskHours, config.maxTaskNudgesPerTick);
    for (const task of staleTasks) {
      if (isQuietHours() && task.priority !== "high") {
        continue;
      }

      await sendText(runtime.sock, config.ownerJid, formatTaskNudge(task));
      await markTaskNudged(task.id);
      await addNudgeLog({
        nudgeType: "stale_task",
        targetJid: config.ownerJid,
        taskId: task.id,
        payload: {
          title: task.title
        }
      });
    }
  } catch (err) {
    logger.error({ err }, "Nudge tick failed");
  } finally {
    runtime.nudgeTickActive = false;
  }
}

async function runDigestTick(force = false) {
  if (runtime.digestTickActive) {
    return;
  }
  runtime.digestTickActive = true;

  try {
    if (!runtime.connected || !runtime.sock) {
      return;
    }
    if (await getPausedState()) {
      return;
    }

    const lastDigestAt = await getLastDigestAt();
    const now = Date.now();
    const intervalMs = config.digestIntervalMinutes * 60_000;
    if (!force && lastDigestAt) {
      const diff = now - new Date(lastDigestAt).getTime();
      if (diff < intervalMs) {
        return;
      }
    }

    const summary = await getDigestSummary(config.digestLookbackHours);
    await sendText(runtime.sock, config.ownerJid, formatDigest(summary, config.digestLookbackHours));
    await setLastDigestAt(new Date());
  } catch (err) {
    logger.error({ err }, "Digest tick failed");
  } finally {
    runtime.digestTickActive = false;
  }
}

async function shutdown(signal) {
  if (runtime.shutdown) {
    return;
  }
  runtime.shutdown = true;
  logger.info({ signal }, "Shutting down");

  try {
    await closeDb();
  } catch (err) {
    logger.error({ err }, "Failed to close DB");
  }

  process.exit(0);
}

async function main() {
  assertConfig();
  await initSchema();
  await connectWhatsApp();

  setInterval(() => {
    runAnalysisTick().catch((err) => logger.error({ err }, "Analysis timer failed"));
  }, config.analyzeIntervalMs);

  setInterval(() => {
    runNudgeTick().catch((err) => logger.error({ err }, "Nudge timer failed"));
  }, config.nudgeIntervalMs);

  setInterval(() => {
    runDigestTick(false).catch((err) => logger.error({ err }, "Digest timer failed"));
  }, 60_000);

  // Prime the loops immediately.
  runAnalysisTick().catch((err) => logger.error({ err }, "Initial analysis failed"));
  runNudgeTick().catch((err) => logger.error({ err }, "Initial nudge failed"));
  runDigestTick(false).catch((err) => logger.error({ err }, "Initial digest failed"));

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch(async (err) => {
  logger.error({ err }, "Fatal startup error");
  await closeDb().catch(() => {});
  process.exit(1);
});
