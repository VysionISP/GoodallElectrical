-- Persistent structured memory (section 6) and the AI question/answer loop
-- (section 7). This is deliberately NOT just LLM conversation history --
-- agents query these tables directly for relevant context.

CREATE TABLE IF NOT EXISTS business_memory (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  category TEXT,
  created_by TEXT NOT NULL DEFAULT 'owner' CHECK (created_by IN ('owner', 'ai_inferred')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS customer_memory (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  category TEXT,
  created_by TEXT NOT NULL DEFAULT 'owner' CHECK (created_by IN ('owner', 'ai_inferred')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_customer_memory_customer ON customer_memory(customer_id);

CREATE TABLE IF NOT EXISTS job_memory (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  category TEXT,
  created_by TEXT NOT NULL DEFAULT 'owner' CHECK (created_by IN ('owner', 'ai_inferred')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_job_memory_job ON job_memory(job_id);

CREATE TABLE IF NOT EXISTS ai_questions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'dismissed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_questions_status ON ai_questions(status);
CREATE INDEX IF NOT EXISTS idx_ai_questions_entity ON ai_questions(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS ai_answers (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES ai_questions(id) ON DELETE CASCADE,
  answer TEXT NOT NULL,
  answered_by TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_answers_question ON ai_answers(question_id);
