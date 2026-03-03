import { query, withTransaction } from "./db.js";

function safeJson(value) {
  return JSON.stringify(value, (_key, current) => {
    if (typeof current === "bigint") {
      return Number(current);
    }
    if (current instanceof Uint8Array) {
      return Buffer.from(current).toString("base64");
    }
    return current;
  });
}

export async function addWatchedGroup(groupJid, groupName, addedByJid) {
  await query(
    `INSERT INTO watched_groups (group_jid, group_name, active, added_by_jid, created_at, updated_at)
     VALUES ($1, $2, TRUE, $3, NOW(), NOW())
     ON CONFLICT (group_jid) DO UPDATE
     SET group_name = EXCLUDED.group_name,
         active = TRUE,
         updated_at = NOW(),
         added_by_jid = EXCLUDED.added_by_jid`,
    [groupJid, groupName || null, addedByJid]
  );
}

export async function deactivateWatchedGroup(groupJid) {
  const result = await query(
    `UPDATE watched_groups
     SET active = FALSE, updated_at = NOW()
     WHERE group_jid = $1`,
    [groupJid]
  );
  return result.rowCount > 0;
}

export async function listWatchedGroups() {
  const result = await query(
    `SELECT group_jid, group_name, active, updated_at
     FROM watched_groups
     WHERE active = TRUE
     ORDER BY group_name NULLS LAST, group_jid ASC`
  );
  return result.rows;
}

export async function isGroupWatched(groupJid) {
  const result = await query(
    `SELECT active
     FROM watched_groups
     WHERE group_jid = $1
     LIMIT 1`,
    [groupJid]
  );
  return result.rows[0]?.active === true;
}

export async function saveIncomingMessage(input) {
  const result = await query(
    `INSERT INTO messages (
       message_id,
       chat_jid,
       group_jid,
       sender_jid,
       from_me,
       sent_at,
       text_content,
       raw_payload,
       created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW())
     ON CONFLICT (message_id) DO NOTHING`,
    [
      input.messageId,
      input.chatJid,
      input.groupJid || null,
      input.senderJid || null,
      input.fromMe,
      input.sentAt,
      input.textContent || null,
      safeJson(input.rawPayload || {})
    ]
  );

  return result.rowCount > 0;
}

export async function listUnprocessedWatchedMessages(limit = 100) {
  const result = await query(
    `SELECT
       m.message_id,
       m.group_jid,
       m.sender_jid,
       m.text_content,
       m.sent_at,
       wg.group_name
     FROM messages m
     INNER JOIN watched_groups wg
       ON wg.group_jid = m.group_jid
      AND wg.active = TRUE
     WHERE m.processed = FALSE
       AND m.from_me = FALSE
       AND COALESCE(m.text_content, '') <> ''
     ORDER BY m.sent_at ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function markMessageAnalysis(messageId, analysis) {
  await query(
    `UPDATE messages
     SET processed = TRUE,
         importance_score = $2,
         importance_reason = $3,
         is_task = $4,
         task_payload = $5::jsonb
     WHERE message_id = $1`,
    [messageId, analysis.importanceScore, analysis.reason, analysis.tasks.length > 0, safeJson(analysis.tasks || [])]
  );
}

export async function insertTasksFromMessage(groupJid, sourceMessageId, tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return 0;
  }

  let inserted = 0;
  for (const task of tasks) {
    const title = String(task.title || "").trim();
    if (!title) {
      continue;
    }

    const result = await query(
      `INSERT INTO tasks (
         group_jid,
         source_message_id,
         title,
         assignee,
         due_hint,
         priority,
         status,
         opened_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'open', NOW())
       ON CONFLICT (source_message_id, title) WHERE status = 'open' DO NOTHING`,
      [groupJid, sourceMessageId, title, task.assignee || null, task.dueHint || null, task.priority || "medium"]
    );

    inserted += result.rowCount;
  }

  return inserted;
}

export async function listOpenTasks(limit = 20) {
  const result = await query(
    `SELECT id, group_jid, title, assignee, due_hint, priority, opened_at
     FROM tasks
     WHERE status = 'open'
     ORDER BY
       CASE priority
         WHEN 'high' THEN 1
         WHEN 'medium' THEN 2
         ELSE 3
       END,
       opened_at ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function markTaskDone(taskId) {
  const result = await query(
    `UPDATE tasks
     SET status = 'done',
         closed_at = NOW()
     WHERE id = $1
       AND status = 'open'
     RETURNING id, title`,
    [taskId]
  );
  return result.rows[0] || null;
}

export async function fetchUrgentUnnudgedMessages(threshold, limit) {
  const result = await query(
    `SELECT
       m.message_id,
       m.group_jid,
       COALESCE(wg.group_name, m.group_jid) AS group_name,
       m.sender_jid,
       m.text_content,
       m.importance_score,
       m.importance_reason,
       m.sent_at
     FROM messages m
     LEFT JOIN watched_groups wg ON wg.group_jid = m.group_jid
     WHERE m.processed = TRUE
       AND m.nudge_sent = FALSE
       AND m.importance_score >= $1
     ORDER BY m.importance_score DESC, m.sent_at ASC
     LIMIT $2`,
    [threshold, limit]
  );
  return result.rows;
}

export async function markMessageNudged(messageId) {
  await query(
    `UPDATE messages
     SET nudge_sent = TRUE
     WHERE message_id = $1`,
    [messageId]
  );
}

export async function fetchStaleOpenTasks(staleHours, limit) {
  const result = await query(
    `SELECT id, group_jid, title, assignee, due_hint, priority, opened_at, last_nudged_at
     FROM tasks
     WHERE status = 'open'
       AND opened_at <= NOW() - make_interval(hours => $1::int)
       AND (
         last_nudged_at IS NULL
         OR last_nudged_at <= NOW() - make_interval(hours => $1::int)
       )
     ORDER BY opened_at ASC
     LIMIT $2`,
    [staleHours, limit]
  );
  return result.rows;
}

export async function markTaskNudged(taskId) {
  await query(
    `UPDATE tasks
     SET last_nudged_at = NOW()
     WHERE id = $1`,
    [taskId]
  );
}

export async function addNudgeLog(input) {
  await query(
    `INSERT INTO nudges (nudge_type, target_jid, message_id, task_id, payload, sent_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NOW())`,
    [input.nudgeType, input.targetJid, input.messageId || null, input.taskId || null, safeJson(input.payload || {})]
  );
}

export async function getPausedState() {
  const result = await query("SELECT paused FROM settings WHERE id = TRUE");
  return result.rows[0]?.paused === true;
}

export async function setPausedState(paused) {
  await query(
    `UPDATE settings
     SET paused = $1,
         updated_at = NOW()
     WHERE id = TRUE`,
    [paused]
  );
}

export async function getLastDigestAt() {
  const result = await query("SELECT last_digest_at FROM settings WHERE id = TRUE");
  return result.rows[0]?.last_digest_at || null;
}

export async function setLastDigestAt(date = new Date()) {
  await query(
    `UPDATE settings
     SET last_digest_at = $1,
         updated_at = NOW()
     WHERE id = TRUE`,
    [date]
  );
}

export async function getDigestSummary(lookbackHours = 24, topMessages = 6, topTasks = 10) {
  const [countResult, importantResult, tasksResult] = await Promise.all([
    query(
      `SELECT COUNT(*)::int AS count
       FROM messages m
       INNER JOIN watched_groups wg
         ON wg.group_jid = m.group_jid
        AND wg.active = TRUE
       WHERE m.sent_at >= NOW() - make_interval(hours => $1::int)`,
      [lookbackHours]
    ),
    query(
      `SELECT
         m.message_id,
         COALESCE(wg.group_name, m.group_jid) AS group_name,
         m.text_content,
         m.importance_score,
         m.sent_at
       FROM messages m
       LEFT JOIN watched_groups wg ON wg.group_jid = m.group_jid
       WHERE m.processed = TRUE
         AND m.importance_score >= 2
         AND m.sent_at >= NOW() - make_interval(hours => $1::int)
       ORDER BY m.importance_score DESC, m.sent_at DESC
       LIMIT $2`,
      [lookbackHours, topMessages]
    ),
    query(
      `SELECT id, group_jid, title, assignee, due_hint, priority, opened_at
       FROM tasks
       WHERE status = 'open'
       ORDER BY
         CASE priority
           WHEN 'high' THEN 1
           WHEN 'medium' THEN 2
           ELSE 3
         END,
         opened_at ASC
       LIMIT $1`,
      [topTasks]
    )
  ]);

  return {
    messageCount: countResult.rows[0]?.count || 0,
    importantMessages: importantResult.rows,
    openTasks: tasksResult.rows
  };
}

export async function findMessageById(messageId) {
  const result = await query(
    `SELECT message_id, text_content, importance_score, importance_reason
     FROM messages
     WHERE message_id = $1`,
    [messageId]
  );
  return result.rows[0] || null;
}

export async function getKeywordScores(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return new Map();
  }

  const result = await query(
    `SELECT keyword, score
     FROM keyword_learning
     WHERE keyword = ANY($1::text[])`,
    [tokens]
  );

  const map = new Map();
  for (const row of result.rows) {
    map.set(row.keyword, Number(row.score) || 0);
  }
  return map;
}

export async function applyFeedbackLabel(messageId, label, tokens) {
  const cleanTokens = Array.from(new Set((tokens || []).filter((token) => token && token.length >= 3))).slice(0, 30);
  const delta = label === "important" ? 0.24 : -0.2;
  const pos = label === "important" ? 1 : 0;
  const neg = label === "ignore" ? 1 : 0;

  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO feedback_events (message_id, label, created_at)
       VALUES ($1, $2, NOW())`,
      [messageId, label]
    );

    for (const token of cleanTokens) {
      await client.query(
        `INSERT INTO keyword_learning (keyword, score, positive_count, negative_count, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (keyword) DO UPDATE
         SET score = LEAST(4, GREATEST(-4, keyword_learning.score + EXCLUDED.score)),
             positive_count = keyword_learning.positive_count + EXCLUDED.positive_count,
             negative_count = keyword_learning.negative_count + EXCLUDED.negative_count,
             updated_at = NOW()`,
        [token, delta, pos, neg]
      );
    }
  });
}
