CREATE TABLE IF NOT EXISTS settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  last_digest_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS watched_groups (
  group_jid TEXT PRIMARY KEY,
  group_name TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  added_by_jid TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  chat_jid TEXT NOT NULL,
  group_jid TEXT,
  sender_jid TEXT,
  from_me BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at TIMESTAMPTZ NOT NULL,
  text_content TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  importance_score DOUBLE PRECISION,
  importance_reason TEXT,
  is_task BOOLEAN NOT NULL DEFAULT FALSE,
  task_payload JSONB NOT NULL DEFAULT '[]'::jsonb,
  nudge_sent BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_group_time ON messages (group_jid, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_processed ON messages (processed, sent_at ASC);
CREATE INDEX IF NOT EXISTS idx_messages_nudge ON messages (nudge_sent, importance_score DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id BIGSERIAL PRIMARY KEY,
  group_jid TEXT NOT NULL,
  source_message_id TEXT REFERENCES messages (message_id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  assignee TEXT,
  due_hint TEXT,
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  last_nudged_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_open_unique
  ON tasks (source_message_id, title)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_tasks_opened ON tasks (status, opened_at ASC);

CREATE TABLE IF NOT EXISTS nudges (
  id BIGSERIAL PRIMARY KEY,
  nudge_type TEXT NOT NULL,
  target_jid TEXT NOT NULL,
  message_id TEXT REFERENCES messages (message_id) ON DELETE SET NULL,
  task_id BIGINT REFERENCES tasks (id) ON DELETE SET NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS keyword_learning (
  keyword TEXT PRIMARY KEY,
  score DOUBLE PRECISION NOT NULL DEFAULT 0,
  positive_count INTEGER NOT NULL DEFAULT 0,
  negative_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feedback_events (
  id BIGSERIAL PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages (message_id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (label IN ('important', 'ignore')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
