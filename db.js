/* Async database adapter.
   Postgres (pg) when DATABASE_URL is set; better-sqlite3 otherwise.
   Route code uses db.all/get/run/exec and `?` placeholders. The Postgres
   driver rewrites those to $1..$n, maps SQLite date helpers, and adds
   RETURNING id so inserts still expose lastInsertRowid. */
const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");

const TABLES_WITH_ID = new Set([
  "users", "markets", "leads", "opt_outs", "templates", "quick_replies",
  "campaigns", "campaign_leads", "messages"
]);

const CONFLICT_TARGETS = {
  user_markets: "user_id, market_id",
  campaign_leads: "campaign_id, lead_id"
};

const sqliteStore = new AsyncLocalStorage();

function sanitize(params) {
  return params.map(x => (x === undefined ? null : x));
}

function normId(v) {
  if (v == null) return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && /^-?\d+$/.test(v)) {
    const n = Number(v);
    if (Number.isSafeInteger(n)) return n;
  }
  return v;
}

function normChanges(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
}

function splitSql(sql) {
  const parts = [];
  let cur = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") cur += sql[i++];
      continue;
    }
    if (c === "'") {
      cur += sql[i++];
      while (i < sql.length) {
        cur += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { cur += sql[++i]; i++; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "$") {
      const m = sql.slice(i).match(/^\$([A-Za-z0-9_]*)\$/);
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        cur += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (c === ";") {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    cur += sql[i++];
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function translateSqliteToPg(sql) {
  let ignoreTable = null;
  let s = sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)/i, (_, table) => {
    ignoreTable = table.toLowerCase();
    return `INSERT INTO ${table}`;
  });
  s = s.replace(/datetime\(\s*'now'\s*,\s*\?\s*\)/gi, "(NOW() + ?::interval)");
  s = s.replace(/datetime\(\s*'now'\s*\)/gi, "NOW()");
  s = s.replace(/strftime\(\s*'%Y-%m'\s*,\s*'now'\s*\)/gi, "to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM')");
  s = s.replace(/strftime\(\s*'%Y-%m'\s*,\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\)/gi, "to_char($1 AT TIME ZONE 'UTC', 'YYYY-MM')");
  s = s.replace(/\bdate\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\)/gi, "to_char($1 AT TIME ZONE 'UTC', 'YYYY-MM-DD')");
  s = s.replace(/\s+COLLATE\s+NOCASE/gi, "");
  if (ignoreTable) {
    const cols = CONFLICT_TARGETS[ignoreTable];
    if (!cols) throw new Error("INSERT OR IGNORE has no Postgres conflict target for " + ignoreTable);
    s = s.replace(/;?\s*$/, "") + ` ON CONFLICT (${cols}) DO NOTHING`;
  }
  return s;
}

function ensureReturning(sql) {
  if (!/^\s*insert\s+/i.test(sql)) return sql;
  if (/\breturning\b/i.test(sql)) return sql;
  const m = sql.match(/^\s*insert\s+into\s+([A-Za-z_][A-Za-z0-9_]*)/i);
  if (!m || !TABLES_WITH_ID.has(m[1].toLowerCase())) return sql;
  return sql.replace(/;?\s*$/, "") + " RETURNING id";
}

function toPlaceholders(sql) {
  let out = "";
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {
      const start = i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out += sql.slice(start, i);
      continue;
    }
    if (c === "?") {
      out += "$" + (++n);
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function prepareSql(sql, driver) {
  let s = String(sql);
  if (driver === "postgres") {
    s = translateSqliteToPg(s);
    s = ensureReturning(s);
    s = toPlaceholders(s);
  }
  return s;
}

function sslFor(connectionString) {
  let host = "";
  try {
    host = new URL(connectionString.replace(/^postgres(?:ql)?:/i, "http:")).hostname;
  } catch { host = ""; }
  /* Local throwaway Postgres has no TLS. Supabase (and anything else) uses SSL
     with rejectUnauthorized:false so the pool accepts Supabase's certificate. */
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
  if (/[?&]sslmode=disable(?:&|$)/i.test(connectionString)) return false;
  return { rejectUnauthorized: false };
}

const SCHEMA_SQLITE = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'rep',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_markets (user_id INTEGER, market_id INTEGER, PRIMARY KEY(user_id, market_id));
CREATE TABLE IF NOT EXISTS markets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, color TEXT DEFAULT '#2563eb',
  settings_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id INTEGER NOT NULL,
  first_name TEXT DEFAULT '', last_name TEXT DEFAULT '',
  phone TEXT DEFAULT '', email TEXT DEFAULT '',
  address TEXT DEFAULT '', city TEXT DEFAULT '', state TEXT DEFAULT '', zip TEXT DEFAULT '',
  tags TEXT DEFAULT '', status TEXT DEFAULT 'new',
  notes TEXT DEFAULT '', custom_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_market ON leads(market_id);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(market_id, phone);
CREATE TABLE IF NOT EXISTS opt_outs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id INTEGER, channel TEXT NOT NULL, value TEXT NOT NULL,
  reason TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_optouts ON opt_outs(channel, value);
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id INTEGER NOT NULL, channel TEXT NOT NULL DEFAULT 'sms',
  name TEXT NOT NULL, subject TEXT DEFAULT '', body TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS quick_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id INTEGER NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id INTEGER NOT NULL, name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'sms',
  status TEXT NOT NULL DEFAULT 'draft',
  steps_json TEXT NOT NULL DEFAULT '[]',
  throttle_per_min INTEGER DEFAULT 20,
  daily_cap INTEGER DEFAULT 2000,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS campaign_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL, lead_id INTEGER NOT NULL,
  step INTEGER DEFAULT 0, next_send_at TEXT,
  status TEXT DEFAULT 'active',
  UNIQUE(campaign_id, lead_id)
);
CREATE INDEX IF NOT EXISTS idx_cl_due ON campaign_leads(status, next_send_at);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id INTEGER NOT NULL, lead_id INTEGER, campaign_id INTEGER,
  direction TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'sms',
  from_addr TEXT DEFAULT '', to_addr TEXT DEFAULT '',
  subject TEXT DEFAULT '', body TEXT DEFAULT '',
  status TEXT DEFAULT 'queued', provider_id TEXT DEFAULT '', error TEXT DEFAULT '',
  user_id INTEGER, read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_msg_market ON messages(market_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_lead ON messages(lead_id);
CREATE INDEX IF NOT EXISTS idx_msg_campaign ON messages(campaign_id, created_at);
CREATE INDEX IF NOT EXISTS idx_optouts_market ON opt_outs(market_id, created_at);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER, created_at TEXT DEFAULT (datetime('now')));
`;

const SCHEMA_PG = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'rep',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS user_markets (
  user_id BIGINT NOT NULL, market_id BIGINT NOT NULL, PRIMARY KEY(user_id, market_id)
);
CREATE TABLE IF NOT EXISTS markets (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL, color TEXT DEFAULT '#2563eb',
  settings_json TEXT DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS leads (
  id BIGSERIAL PRIMARY KEY,
  market_id BIGINT NOT NULL,
  first_name TEXT DEFAULT '', last_name TEXT DEFAULT '',
  phone TEXT DEFAULT '', email TEXT DEFAULT '',
  address TEXT DEFAULT '', city TEXT DEFAULT '', state TEXT DEFAULT '', zip TEXT DEFAULT '',
  tags TEXT DEFAULT '', status TEXT DEFAULT 'new',
  notes TEXT DEFAULT '', custom_json TEXT DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_leads_market ON leads(market_id);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(market_id, phone);
CREATE TABLE IF NOT EXISTS opt_outs (
  id BIGSERIAL PRIMARY KEY,
  market_id BIGINT, channel TEXT NOT NULL, value TEXT NOT NULL,
  reason TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_optouts ON opt_outs(channel, value);
CREATE TABLE IF NOT EXISTS templates (
  id BIGSERIAL PRIMARY KEY,
  market_id BIGINT NOT NULL, channel TEXT NOT NULL DEFAULT 'sms',
  name TEXT NOT NULL, subject TEXT DEFAULT '', body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS quick_replies (
  id BIGSERIAL PRIMARY KEY,
  market_id BIGINT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campaigns (
  id BIGSERIAL PRIMARY KEY,
  market_id BIGINT NOT NULL, name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'sms',
  status TEXT NOT NULL DEFAULT 'draft',
  steps_json TEXT NOT NULL DEFAULT '[]',
  throttle_per_min INTEGER DEFAULT 20,
  daily_cap INTEGER DEFAULT 2000,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS campaign_leads (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT NOT NULL, lead_id BIGINT NOT NULL,
  step INTEGER DEFAULT 0, next_send_at TIMESTAMPTZ,
  status TEXT DEFAULT 'active',
  UNIQUE(campaign_id, lead_id)
);
CREATE INDEX IF NOT EXISTS idx_cl_due ON campaign_leads(status, next_send_at);
CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  market_id BIGINT NOT NULL, lead_id BIGINT, campaign_id BIGINT,
  direction TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'sms',
  from_addr TEXT DEFAULT '', to_addr TEXT DEFAULT '',
  subject TEXT DEFAULT '', body TEXT DEFAULT '',
  status TEXT DEFAULT 'queued', provider_id TEXT DEFAULT '', error TEXT DEFAULT '',
  user_id BIGINT, read INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_msg_market ON messages(market_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_lead ON messages(lead_id);
CREATE INDEX IF NOT EXISTS idx_msg_campaign ON messages(campaign_id, created_at);
CREATE INDEX IF NOT EXISTS idx_optouts_market ON opt_outs(market_id, created_at);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id BIGINT, created_at TIMESTAMPTZ DEFAULT NOW()
);
`;

const APP_TABLES = [
  "settings", "users", "user_markets", "markets", "leads", "opt_outs",
  "templates", "quick_replies", "campaigns", "campaign_leads", "messages", "sessions"
];

function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("unsafe identifier");
  return name;
}

class SqliteAdapter {
  constructor(raw, impl) {
    this.raw = raw;
    this.driver = "sqlite";
    this.impl = impl;
    this._chain = Promise.resolve();
  }

  _lock(fn) {
    if (sqliteStore.getStore() === this) return Promise.resolve().then(fn);
    const run = this._chain.then(() => sqliteStore.run(this, fn));
    this._chain = run.then(() => {}, () => {});
    return run;
  }

  exec(sql) {
    return this._lock(async () => { this.raw.exec(sql); });
  }

  all(sql, ...params) {
    return this._lock(async () => this.raw.prepare(sql).all(...sanitize(params)));
  }

  get(sql, ...params) {
    return this._lock(async () => this.raw.prepare(sql).get(...sanitize(params)));
  }

  run(sql, ...params) {
    return this._lock(async () => {
      const info = this.raw.prepare(sql).run(...sanitize(params)) || {};
      return { changes: normChanges(info.changes), lastInsertRowid: normId(info.lastInsertRowid) };
    });
  }

  transaction(fn) {
    return this._lock(async () => {
      this.raw.exec("BEGIN");
      try {
        const tx = {
          all: (sql, ...params) => Promise.resolve(this.raw.prepare(sql).all(...sanitize(params))),
          get: (sql, ...params) => Promise.resolve(this.raw.prepare(sql).get(...sanitize(params))),
          run: (sql, ...params) => {
            const info = this.raw.prepare(sql).run(...sanitize(params)) || {};
            return Promise.resolve({ changes: normChanges(info.changes), lastInsertRowid: normId(info.lastInsertRowid) });
          }
        };
        const result = await fn(tx);
        this.raw.exec("COMMIT");
        return result;
      } catch (e) {
        try { this.raw.exec("ROLLBACK"); } catch { /* already closed */ }
        throw e;
      }
    });
  }

  async close() {
    if (typeof this.raw.close === "function") this.raw.close();
  }
}

class PgAdapter {
  constructor(queryable, pool) {
    this.queryable = queryable;
    this.pool = pool || null;
    this.driver = "postgres";
    this.impl = "pg";
  }

  async _query(sql, params) {
    const text = prepareSql(sql, "postgres");
    return this.queryable.query(text, sanitize(params));
  }

  async exec(sql) {
    for (const part of splitSql(sql)) await this.queryable.query(part);
  }

  async all(sql, ...params) {
    const result = await this._query(sql, params);
    return result.rows;
  }

  async get(sql, ...params) {
    const rows = await this.all(sql, ...params);
    return rows[0];
  }

  async run(sql, ...params) {
    const result = await this._query(sql, params);
    const id = result.rows && result.rows[0] ? result.rows[0].id : undefined;
    return { changes: normChanges(result.rowCount), lastInsertRowid: normId(id) };
  }

  async transaction(fn) {
    if (!this.pool || this.queryable !== this.pool) return fn(this);
    const client = await this.pool.connect();
    const tx = new PgAdapter(client, null);
    try {
      await client.query("BEGIN");
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* connection already dead */ }
      throw e;
    } finally {
      client.release();
    }
  }

  async close() {
    if (this.pool) await this.pool.end();
  }
}

function openSqlite(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  let raw;
  let impl;
  try {
    const Database = require("better-sqlite3");
    raw = new Database(dbPath);
    impl = "better-sqlite3";
  } catch (err) {
    try {
      const { DatabaseSync } = require("node:sqlite");
      raw = new DatabaseSync(dbPath);
      impl = "node:sqlite";
    } catch {
      throw new Error("SQLite fallback needs better-sqlite3 (or Node 22 node:sqlite). Set DATABASE_URL to use Postgres. " + err.message);
    }
  }
  raw.exec("PRAGMA journal_mode = WAL;");
  return new SqliteAdapter(raw, impl);
}

function openPg(connectionString) {
  const { Pool, types } = require("pg");
  /* COUNT/SUM come back as int8 or numeric. Keep them JS numbers so caps and JSON match SQLite. */
  types.setTypeParser(20, v => (v == null ? null : Number(v)));
  types.setTypeParser(1700, v => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  });
  const pool = new Pool({
    connectionString,
    ssl: sslFor(connectionString),
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    application_name: "lariat-pro"
  });
  pool.on("error", err => console.error("Postgres pool error:", err.message));
  return new PgAdapter(pool, pool);
}

function openDatabase({ dbPath } = {}) {
  const url = (process.env.DATABASE_URL || "").trim();
  if (url) return openPg(url);
  const file = dbPath || path.join(process.env.DATA_DIR || process.cwd(), "lariat.db");
  return openSqlite(file);
}

async function enableRls(db) {
  for (const table of APP_TABLES) {
    await db.exec(`ALTER TABLE ${quoteIdent(table)} ENABLE ROW LEVEL SECURITY`);
  }
  const roles = await db.all("SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')");
  if (!roles.length) return;
  const roleList = roles.map(r => quoteIdent(r.rolname)).join(", ");
  for (const table of APP_TABLES) {
    await db.exec(`REVOKE ALL ON TABLE ${quoteIdent(table)} FROM ${roleList}`);
    const seq = await db.get(
      "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'S' AND n.nspname = 'public' AND c.relname = ?",
      table + "_id_seq"
    );
    if (seq) await db.exec(`REVOKE ALL ON SEQUENCE ${quoteIdent(seq.name)} FROM ${roleList}`);
  }
}

async function initDatabase(db) {
  if (db.driver === "postgres") {
    await db.exec(SCHEMA_PG);
    await enableRls(db);
    return;
  }
  await db.exec(SCHEMA_SQLITE);
}

module.exports = { openDatabase, initDatabase, prepareSql, splitSql, SCHEMA_PG, SCHEMA_SQLITE };
