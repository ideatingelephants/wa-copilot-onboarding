import { config, normalizeJid } from "./config.js";
import { tokenize } from "./analysis.js";
import { formatDigest, sendText } from "./notifier.js";
import {
  addWatchedGroup,
  applyFeedbackLabel,
  deactivateWatchedGroup,
  findMessageById,
  getDigestSummary,
  getPausedState,
  listOpenTasks,
  listWatchedGroups,
  markTaskDone,
  setPausedState
} from "./store.js";

function bareJid(jid) {
  return normalizeJid(jid);
}

export function isOwner(senderJid) {
  return bareJid(senderJid) === bareJid(config.ownerJid);
}

function parseCommand(text) {
  const raw = (text || "").trim();
  if (!raw.startsWith("/")) {
    return null;
  }
  const parts = raw.split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);
  return { command, args };
}

async function resolveGroupName(sock, groupJid) {
  try {
    const metadata = await sock.groupMetadata(groupJid);
    return metadata?.subject || null;
  } catch {
    return null;
  }
}

function normalizeGroupArg(arg) {
  const value = (arg || "").trim();
  if (!value) {
    return "";
  }
  if (value.endsWith("@g.us")) {
    return value;
  }
  return "";
}

function formatHelp() {
  return [
    "Commands",
    "/watch [group_jid] - start monitoring this group",
    "/unwatch [group_jid] - stop monitoring this group",
    "/groups - list watched groups",
    "/tasks - list open tasks",
    "/done <task_id> - mark a task done",
    "/label <message_id> important|ignore - train relevance",
    "/digest - send summary now",
    "/pause - pause nudges/analysis",
    "/resume - resume nudges/analysis",
    "/status - show bot status",
    "/help"
  ].join("\n");
}

function formatTasks(rows) {
  if (!rows.length) {
    return "No open tasks.";
  }
  const lines = ["Open tasks:"];
  for (const task of rows) {
    const assignee = task.assignee ? ` @${task.assignee}` : "";
    const due = task.due_hint ? ` | due ${task.due_hint}` : "";
    lines.push(`- #${task.id} (${task.priority}) ${task.title}${assignee}${due}`);
  }
  return lines.join("\n");
}

function formatGroups(rows) {
  if (!rows.length) {
    return "No watched groups. Use /watch in a group to start.";
  }
  const lines = ["Watched groups:"];
  for (const row of rows) {
    lines.push(`- ${row.group_name || "(unnamed)"} | ${row.group_jid}`);
  }
  return lines.join("\n");
}

export async function handleOwnerCommand(context) {
  const { sock, chatJid, isGroup, senderJid, text } = context;
  const parsed = parseCommand(text);
  if (!parsed) {
    return false;
  }
  if (!isOwner(senderJid)) {
    return false;
  }

  const { command, args } = parsed;

  if (command === "/help") {
    await sendText(sock, chatJid, formatHelp());
    return true;
  }

  if (command === "/watch") {
    const groupJid = isGroup ? chatJid : normalizeGroupArg(args[0]);
    if (!groupJid) {
      await sendText(sock, chatJid, "Use /watch inside a group or pass full group_jid in DM.");
      return true;
    }

    const groupName = await resolveGroupName(sock, groupJid);
    await addWatchedGroup(groupJid, groupName, senderJid);
    await sendText(sock, chatJid, `Watching: ${groupName || groupJid}`);
    return true;
  }

  if (command === "/unwatch") {
    const groupJid = isGroup ? chatJid : normalizeGroupArg(args[0]);
    if (!groupJid) {
      await sendText(sock, chatJid, "Use /unwatch inside a group or pass full group_jid in DM.");
      return true;
    }

    const changed = await deactivateWatchedGroup(groupJid);
    await sendText(sock, chatJid, changed ? `Stopped watching: ${groupJid}` : `Group not found: ${groupJid}`);
    return true;
  }

  if (command === "/groups") {
    const groups = await listWatchedGroups();
    await sendText(sock, chatJid, formatGroups(groups));
    return true;
  }

  if (command === "/tasks") {
    const tasks = await listOpenTasks(20);
    await sendText(sock, chatJid, formatTasks(tasks));
    return true;
  }

  if (command === "/done") {
    const taskId = Number.parseInt(args[0] || "", 10);
    if (!Number.isFinite(taskId)) {
      await sendText(sock, chatJid, "Usage: /done <task_id>");
      return true;
    }
    const done = await markTaskDone(taskId);
    await sendText(sock, chatJid, done ? `Marked done: #${done.id} ${done.title}` : `No open task found for #${taskId}`);
    return true;
  }

  if (command === "/digest") {
    const summary = await getDigestSummary(config.digestLookbackHours);
    await sendText(sock, chatJid, formatDigest(summary, config.digestLookbackHours));
    return true;
  }

  if (command === "/pause") {
    await setPausedState(true);
    await sendText(sock, chatJid, "Paused. Ingest continues, but analysis and nudges are paused.");
    return true;
  }

  if (command === "/resume") {
    await setPausedState(false);
    await sendText(sock, chatJid, "Resumed.");
    return true;
  }

  if (command === "/status") {
    const [paused, groups, tasks] = await Promise.all([getPausedState(), listWatchedGroups(), listOpenTasks(5)]);
    await sendText(
      sock,
      chatJid,
      [`Status: ${paused ? "paused" : "running"}`, `Watched groups: ${groups.length}`, `Open tasks: ${tasks.length}`].join("\n")
    );
    return true;
  }

  if (command === "/label") {
    const messageId = (args[0] || "").trim();
    const labelRaw = (args[1] || "").trim().toLowerCase();
    if (!messageId || !["important", "ignore"].includes(labelRaw)) {
      await sendText(sock, chatJid, "Usage: /label <message_id> important|ignore");
      return true;
    }

    const message = await findMessageById(messageId);
    if (!message) {
      await sendText(sock, chatJid, `Message not found: ${messageId}`);
      return true;
    }

    const tokens = tokenize(message.text_content || "");
    await applyFeedbackLabel(messageId, labelRaw, tokens);
    await sendText(sock, chatJid, `Saved label '${labelRaw}' for ${messageId}. Learned ${tokens.length} keywords.`);
    return true;
  }

  await sendText(sock, chatJid, `Unknown command: ${command}\n\n${formatHelp()}`);
  return true;
}
