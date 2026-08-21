import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const parse = (value, fallback = {}) => {
  try { return JSON.parse(value); } catch { return fallback; }
};

export class Store {
  constructor(filename) {
    const directory = path.dirname(filename);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const previousUmask = process.umask(0o077);
    try { this.db = new DatabaseSync(filename); }
    finally { process.umask(previousUmask); }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        title TEXT NOT NULL,
        payload TEXT NOT NULL,
        result TEXT,
        status TEXT NOT NULL,
        policy_reason TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        FOREIGN KEY(task_id) REFERENCES tasks(id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT,
        action_id TEXT,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.#ensureColumn("tasks", "source", "TEXT NOT NULL DEFAULT 'web'");
    this.#ensureColumn("tasks", "source_ref", "TEXT");
    this.#ensureColumn("actions", "approval_code", "TEXT");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_actions_approval_code ON actions(approval_code) WHERE approval_code IS NOT NULL");
    for (const candidate of [filename, `${filename}-wal`, `${filename}-shm`]) {
      if (fs.existsSync(candidate)) fs.chmodSync(candidate, 0o600);
    }
  }

  #ensureColumn(table, column, definition) {
    const found = this.db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
    if (!found) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  createTask(task) {
    this.db.prepare("INSERT INTO tasks (id,prompt,summary,status,created_at,source,source_ref) VALUES (?,?,?,?,?,?,?)")
      .run(task.id, task.prompt, task.summary, task.status, task.createdAt, task.source || "web", task.sourceRef ?? null);
    return task;
  }

  updateTask(id, fields) {
    const allowed = ["summary", "status"];
    const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
    if (!entries.length) return;
    this.db.prepare(`UPDATE tasks SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`)
      .run(...entries.map(([, value]) => value), id);
  }

  getTask(id) {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? this.#task(row) : null;
  }

  createAction(action) {
    this.db.prepare("INSERT INTO actions (id,task_id,tool,title,payload,result,status,policy_reason,created_at,decided_at,approval_code) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(action.id, action.taskId, action.tool, action.title, JSON.stringify(action.payload), null, action.status, action.policyReason ?? null, action.createdAt, null, action.approvalCode ?? null);
    return action;
  }

  decideAction(id, status, result) {
    this.db.prepare("UPDATE actions SET status = ?, result = ?, decided_at = ? WHERE id = ?")
      .run(status, JSON.stringify(result), new Date().toISOString(), id);
  }

  getAction(id) {
    const row = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id);
    return row ? this.#action(row) : null;
  }

  getActionByCode(code) {
    const row = this.db.prepare("SELECT * FROM actions WHERE approval_code = ? ORDER BY created_at DESC LIMIT 1").get(String(code));
    return row ? this.#action(row) : null;
  }

  actionsForTask(taskId) {
    return this.db.prepare("SELECT * FROM actions WHERE task_id = ? ORDER BY created_at").all(taskId).map((row) => this.#action(row));
  }

  addEvent(event) {
    this.db.prepare("INSERT INTO events (task_id,action_id,kind,message,created_at) VALUES (?,?,?,?,?)")
      .run(event.taskId ?? null, event.actionId ?? null, event.kind, event.message, event.createdAt ?? new Date().toISOString());
  }

  getSetting(key, fallback = null) {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? parse(row.value, fallback) : fallback;
  }

  setSetting(key, value) {
    this.db.prepare(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  deleteSetting(key) {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  prune(retentionDays = 30) {
    const days = Number(retentionDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) return 0;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const expired = this.db.prepare("SELECT id FROM tasks WHERE created_at < ?").all(cutoff).map((row) => row.id);
    if (!expired.length) return 0;
    const removeEvents = this.db.prepare("DELETE FROM events WHERE task_id = ?");
    const removeActions = this.db.prepare("DELETE FROM actions WHERE task_id = ?");
    const removeTask = this.db.prepare("DELETE FROM tasks WHERE id = ?");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of expired) {
        removeEvents.run(id);
        removeActions.run(id);
        removeTask.run(id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return expired.length;
  }

  state() {
    const tasks = this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 30").all().map((row) => this.#task(row));
    const actions = this.db.prepare("SELECT * FROM actions ORDER BY created_at DESC LIMIT 80").all().map((row) => this.#action(row));
    const events = this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 100").all();
    return { tasks, actions, events };
  }

  #task(row) {
    return { ...row, createdAt: row.created_at, sourceRef: row.source_ref };
  }

  #action(row) {
    return {
      ...row,
      taskId: row.task_id,
      policyReason: row.policy_reason,
      approvalCode: row.approval_code,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
      payload: parse(row.payload),
      result: row.result ? parse(row.result) : null
    };
  }
}
