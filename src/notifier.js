import { config } from "./config.js";
import { shortSnippet } from "./messages.js";

function localHour(date = new Date()) {
  const hour = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hour12: false,
    timeZone: config.timezone
  }).format(date);
  return Number.parseInt(hour, 10);
}

export function isQuietHours(date = new Date()) {
  const h = localHour(date);
  const start = config.quietHoursStart;
  const end = config.quietHoursEnd;
  if (start === end) {
    return false;
  }

  if (start < end) {
    return h >= start && h < end;
  }

  return h >= start || h < end;
}

export async function sendText(sock, jid, text) {
  await sock.sendMessage(jid, { text });
}

function fmtDate(date) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: config.timezone
  }).format(new Date(date));
}

export function formatUrgentNudge(row) {
  return [
    `Intervention likely needed`,
    `Group: ${row.group_name || row.group_jid}`,
    `Score: ${Number(row.importance_score || 0).toFixed(1)} (${row.importance_reason || "no_reason"})`,
    `At: ${fmtDate(row.sent_at)}`,
    `Message: ${shortSnippet(row.text_content, 220)}`,
    `Reply: /label ${row.message_id} important|ignore`
  ].join("\n");
}

export function formatTaskNudge(task) {
  const assignee = task.assignee ? ` @${task.assignee}` : "";
  const due = task.due_hint ? ` | due: ${task.due_hint}` : "";
  return [
    `Task follow-up needed`,
    `Task #${task.id}: ${task.title}${assignee}${due}`,
    `Priority: ${task.priority} | Opened: ${fmtDate(task.opened_at)}`,
    `Reply: /done ${task.id}`
  ].join("\n");
}

export function formatDigest(summary, lookbackHours) {
  const lines = [];
  lines.push(`Digest (${lookbackHours}h)`);
  lines.push(`Messages scanned: ${summary.messageCount}`);
  lines.push(`Open tasks: ${summary.openTasks.length}`);

  if (summary.importantMessages.length > 0) {
    lines.push("");
    lines.push("Top important messages:");
    for (const msg of summary.importantMessages.slice(0, 5)) {
      lines.push(
        `- [${Number(msg.importance_score || 0).toFixed(1)}] ${msg.group_name}: ${shortSnippet(msg.text_content, 100)}`
      );
    }
  }

  if (summary.openTasks.length > 0) {
    lines.push("");
    lines.push("Open tasks:");
    for (const task of summary.openTasks.slice(0, 8)) {
      const assignee = task.assignee ? ` @${task.assignee}` : "";
      lines.push(`- #${task.id} (${task.priority}) ${task.title}${assignee}`);
    }
  }

  lines.push("");
  lines.push("Commands: /groups /tasks /digest /pause /resume");
  return lines.join("\n");
}
