export function migrateFengxiSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS fengxi_instance (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      service_owner TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fengxi_project_bindings (
      project_id TEXT PRIMARY KEY REFERENCES projects(id),
      source_project_id TEXT NOT NULL UNIQUE,
      workspace_root TEXT NOT NULL,
      state_card_path TEXT,
      allowed_scopes TEXT NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
      excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
      allow_main INTEGER NOT NULL DEFAULT 0 CHECK (allow_main IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fengxi_card_state (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      requirement_revision INTEGER NOT NULL DEFAULT 1 CHECK (requirement_revision > 0),
      route TEXT CHECK (route IN ('direct', 'cursor_queue') OR route IS NULL),
      pending_changes INTEGER NOT NULL DEFAULT 0 CHECK (pending_changes IN (0, 1)),
      paused_delivery INTEGER NOT NULL DEFAULT 0 CHECK (paused_delivery IN (0, 1)),
      approved_scope_json TEXT,
      current_attempt_id TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fengxi_execution_attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      requirement_revision INTEGER NOT NULL,
      attempt_sequence INTEGER NOT NULL,
      parent_attempt_id TEXT,
      route TEXT NOT NULL CHECK (route IN ('direct', 'cursor_queue')),
      status TEXT NOT NULL,
      job_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      queue_task_id TEXT,
      queue_sent TEXT,
      queue_owner TEXT,
      chat_owner TEXT,
      evidence_json TEXT,
      evidence_hash TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (task_id, requirement_revision, attempt_sequence),
      UNIQUE (job_id),
      UNIQUE (request_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS fengxi_attempts_one_open
      ON fengxi_execution_attempts(task_id)
      WHERE status IN (
        'reserving', 'claimed', 'queued', 'submitting', 'submitted',
        'running', 'returned', 'submission_unknown'
      );

    CREATE TABLE IF NOT EXISTS fengxi_execution_outbox (
      id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL REFERENCES fengxi_execution_attempts(id) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK (action IN ('submit', 'status', 'cancel')),
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'in_flight', 'acked', 'unknown', 'held')),
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fengxi_acceptances (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL REFERENCES fengxi_execution_attempts(id),
      requirement_revision INTEGER NOT NULL,
      evidence_hash TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const attemptColumns = database.prepare("PRAGMA table_info(fengxi_execution_attempts)").all();
  if (!attemptColumns.some(column => column.name === 'managed_json')) database.exec("ALTER TABLE fengxi_execution_attempts ADD COLUMN managed_json TEXT");
  const columns = database.prepare("PRAGMA table_info(fengxi_card_state)").all();
  if (!columns.some(column => column.name === 'approval_json')) {
    database.exec("ALTER TABLE fengxi_card_state ADD COLUMN approval_json TEXT");
  }
  const bindingColumns = database.prepare("PRAGMA table_info(fengxi_project_bindings)").all();
  if (!bindingColumns.some(column => column.name === 'allow_main')) {
    database.exec("ALTER TABLE fengxi_project_bindings ADD COLUMN allow_main INTEGER NOT NULL DEFAULT 0 CHECK (allow_main IN (0, 1))");
  }
}
