/* =========================================================================
   LARIAT PRO — multi-market SMS + cold-email outreach platform
   Node + Express + SQLite. Twilio for SMS, SendGrid (or any SMTP) for email.
   ========================================================================= */
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = path.join(DATA_DIR, "lariat.db");

/* SQLite via Node's built-in node:sqlite (Node 22+) — no native compile step.
   Falls back to better-sqlite3 if installed. Both get a thin compat wrapper
   so prepared statements accept undefined params (converted to null).      */
function openDb() {
  const sanitize = a => a.map(x => x === undefined ? null : x);
  try {
    const { DatabaseSync } = require("node:sqlite");
    const raw = new DatabaseSync(DB_PATH);
    raw.exec("PRAGMA journal_mode = WAL;");
    return {
      exec: sql => raw.exec(sql),
      prepare: sql => {
        const st = raw.prepare(sql);
        return {
          run: (...a) => st.run(...sanitize(a)),
          get: (...a) => st.get(...sanitize(a)),
          all: (...a) => st.all(...sanitize(a))
        };
      },
      transaction: fn => (...args) => { raw.exec("BEGIN"); try { const r = fn(...args); raw.exec("COMMIT"); return r; } catch (e) { raw.exec("ROLLBACK"); throw e; } }
    };
  } catch (e) {
    const Database = require("better-sqlite3");
    const raw = new Database(DB_PATH);
    raw.pragma("journal_mode = WAL");
    return {
      exec: sql => raw.exec(sql),
      prepare: sql => {
        const st = raw.prepare(sql);
        return {
          run: (...a) => st.run(...sanitize(a)),
          get: (...a) => st.get(...sanitize(a)),
          all: (...a) => st.all(...sanitize(a))
        };
      },
      transaction: fn => raw.transaction(fn)
    };
  }
}
const db = openDb();
let a2pCache = null;

/* ----------------------------- schema --------------------------------- */
db.exec(`
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
`);

/* ----------------------------- helpers -------------------------------- */
const getSetting = k => { const r = db.prepare("SELECT value FROM settings WHERE key=?").get(k); return r ? r.value : null; };
const setSetting = (k, v) => db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, v == null ? "" : String(v));
const hashPass = (pw, salt) => { salt = salt || crypto.randomBytes(16).toString("hex"); return salt + ":" + crypto.scryptSync(pw, salt, 32).toString("hex"); };
const checkPass = (pw, stored) => { const [salt] = stored.split(":"); return crypto.timingSafeEqual(Buffer.from(hashPass(pw, salt)), Buffer.from(stored)); };
const normPhone = p => {
  if (!p) return "";
  let d = String(p).replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.length === 10 ? "+1" + d : (String(p).startsWith("+") ? String(p) : "");
};
const spintax = s => s.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, g) => { const o = g.split("|"); return o[Math.floor(Math.random() * o.length)]; });
const merge = (tpl, lead) => {
  const c = JSON.parse(lead.custom_json || "{}");
  return spintax(tpl).replace(/\{\{\s*([\w ]+)\s*\}\}/g, (_, k) => {
    k = k.trim().toLowerCase().replace(/ /g, "_");
    if (lead[k] != null && lead[k] !== "") return lead[k];
    if (c[k] != null) return c[k];
    if (k === "name" || k === "full_name") return (lead.first_name + " " + lead.last_name).trim();
    return "";
  });
};
const marketSettings = m => Object.assign({
  from_numbers: [], email_from: "", email_from_name: "",
  daily_sms_cap: 3000, msgs_per_min: 30, quiet_start: 8, quiet_end: 21, tz_offset: -8
}, JSON.parse(m.settings_json || "{}"));

/* --------------------------- providers --------------------------------- */
async function twilioSend(from, to, body) {
  const sid = getSetting("twilio_sid"), tok = getSetting("twilio_token");
  if (!sid || !tok) throw new Error("Twilio not configured (Settings → Twilio)");
  const cb = getSetting("public_url") ? `${getSetting("public_url")}/webhooks/twilio/status` : null;
  const params = new URLSearchParams({ From: from, To: to, Body: body });
  if (cb) params.set("StatusCallback", cb);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(sid + ":" + tok).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || "Twilio error " + r.status);
  return j.sid;
}

function twilioAuthHeader() {
  const sid = getSetting("twilio_sid"), tok = getSetting("twilio_token");
  if (!sid || !tok) return null;
  return "Basic " + Buffer.from(sid + ":" + tok).toString("base64");
}
async function twilioGet(url) {
  const auth = twilioAuthHeader();
  if (!auth) {
    const e = new Error("Twilio not configured");
    e.code = "not_configured";
    throw e;
  }
  let r;
  try {
    r = await fetch(url, { headers: { Authorization: auth }, signal: AbortSignal.timeout(12000) });
  } catch (e) {
    const err = new Error(e.name === "TimeoutError" || e.name === "AbortError" ? "Twilio request timed out" : (e.message || "Twilio request failed"));
    err.status = 0;
    throw err;
  }
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!r.ok) {
    const err = new Error((json && (json.message || json.detail)) || ("Twilio error " + r.status));
    err.status = r.status;
    throw err;
  }
  return json || {};
}
function twilioRows(page, preferred) {
  if (!page || typeof page !== "object") return [];
  if (preferred && Array.isArray(page[preferred])) return page[preferred];
  if (page.meta && page.meta.key && Array.isArray(page[page.meta.key])) return page[page.meta.key];
  for (const k of ["data", "services", "compliance", "phone_numbers", "incoming_phone_numbers", "results"]) {
    if (Array.isArray(page[k])) return page[k];
  }
  return [];
}
async function twilioCollect(startUrl, preferredKey) {
  const out = [];
  let url = startUrl;
  const origin = new URL(startUrl).origin;
  const seen = new Set();
  for (let i = 0; i < 6 && url; i++) {
    if (seen.has(url)) break;
    seen.add(url);
    const page = await twilioGet(url);
    out.push(...twilioRows(page, preferredKey));
    const next = (page.meta && page.meta.next_page_url) || page.next_page_uri || null;
    if (!next) break;
    url = String(next).startsWith("http") ? String(next) : origin + next;
  }
  return out;
}
function normalizeUrl(u) {
  return String(u || "").trim().replace(/\/$/, "").toLowerCase();
}

let nodemailer = null;
async function emailSend({ fromName, fromEmail, to, subject, html, text, unsubUrl }) {
  const sgKey = getSetting("sendgrid_key");
  const headers = unsubUrl ? { "List-Unsubscribe": `<${unsubUrl}>` } : {};
  if (sgKey) {
    const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: "Bearer " + sgKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: fromEmail, name: fromName || undefined },
        subject,
        headers,
        content: [{ type: "text/plain", value: text }, { type: "text/html", value: html }]
      })
    });
    if (!r.ok) throw new Error("SendGrid error " + r.status + ": " + (await r.text()).slice(0, 300));
    return "sendgrid";
  }
  const smtp = JSON.parse(getSetting("smtp_json") || "null");
  if (smtp && smtp.host) {
    nodemailer = nodemailer || require("nodemailer");
    const t = nodemailer.createTransport({ host: smtp.host, port: +smtp.port || 587, secure: +smtp.port === 465, auth: { user: smtp.user, pass: smtp.pass } });
    const info = await t.sendMail({ from: `"${fromName || ""}" <${fromEmail}>`, to, subject, text, html, headers });
    return info.messageId || "smtp";
  }
  throw new Error("No email provider configured (Settings → Email)");
}

/* ----------------------------- app ------------------------------------ */
const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

/* auth */
function auth(req, res, next) {
  const tok = (req.headers.authorization || "").replace("Bearer ", "") || req.query.token;
  const s = tok && db.prepare("SELECT * FROM sessions WHERE token=?").get(tok);
  if (!s) return res.status(401).json({ error: "unauthorized" });
  req.user = db.prepare("SELECT id,name,email,role FROM users WHERE id=?").get(s.user_id);
  if (!req.user) return res.status(401).json({ error: "unauthorized" });
  next();
}
const admin = (req, res, next) => req.user.role === "admin" ? next() : res.status(403).json({ error: "admin only" });
function userMarketIds(u) {
  if (u.role === "admin") return db.prepare("SELECT id FROM markets").all().map(r => r.id);
  return db.prepare("SELECT market_id FROM user_markets WHERE user_id=?").all(u.id).map(r => r.market_id);
}
function requireMarket(req, res, next) {
  const mid = +(req.params.marketId || req.body.market_id || req.query.market_id);
  if (!userMarketIds(req.user).includes(mid)) return res.status(403).json({ error: "no access to this market" });
  req.marketId = mid;
  req.market = db.prepare("SELECT * FROM markets WHERE id=?").get(mid);
  next();
}

/* first-run: create admin */
app.get("/api/bootstrap", (req, res) => {
  const count = db.prepare("SELECT COUNT(*) c FROM users").get().c;
  res.json({ needsSetup: count === 0 });
});
app.post("/api/setup", (req, res) => {
  if (db.prepare("SELECT COUNT(*) c FROM users").get().c > 0) return res.status(400).json({ error: "already set up" });
  const { name, email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  db.prepare("INSERT INTO users(name,email,pass_hash,role) VALUES(?,?,?,'admin')").run(name || "Admin", email.toLowerCase(), hashPass(password));
  for (const [n, c] of [["Land", "#16a34a"], ["Vegas Realtors", "#dc2626"], ["Homeowners", "#2563eb"], ["Dispo", "#9333ea"]])
    db.prepare("INSERT INTO markets(name,color) VALUES(?,?)").run(n, c);
  res.json({ ok: true });
});
app.post("/api/login", (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE email=?").get((req.body.email || "").toLowerCase());
  if (!u || !checkPass(req.body.password || "", u.pass_hash)) return res.status(401).json({ error: "bad email or password" });
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO sessions(token,user_id) VALUES(?,?)").run(token, u.id);
  res.json({ token, user: { id: u.id, name: u.name, email: u.email, role: u.role }, markets: userMarketIds(u) });
});
app.post("/api/logout", auth, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE token=?").run((req.headers.authorization || "").replace("Bearer ", ""));
  res.json({ ok: true });
});
app.get("/api/me", auth, (req, res) => {
  const mids = userMarketIds(req.user);
  const markets = db.prepare(`SELECT * FROM markets WHERE id IN (${mids.map(() => "?").join(",") || "0"})`).all(...mids);
  res.json({ user: req.user, markets: markets.map(m => ({ ...m, settings: marketSettings(m) })) });
});

/* users (admin) */
app.get("/api/users", auth, admin, (req, res) => {
  const users = db.prepare("SELECT id,name,email,role,created_at FROM users").all();
  for (const u of users) u.markets = db.prepare("SELECT market_id FROM user_markets WHERE user_id=?").all(u.id).map(r => r.market_id);
  res.json(users);
});
app.post("/api/users", auth, admin, (req, res) => {
  const { name, email, password, role, markets } = req.body;
  try {
    const r = db.prepare("INSERT INTO users(name,email,pass_hash,role) VALUES(?,?,?,?)").run(name, email.toLowerCase(), hashPass(password), role === "admin" ? "admin" : "rep");
    for (const mid of markets || []) db.prepare("INSERT OR IGNORE INTO user_markets(user_id,market_id) VALUES(?,?)").run(r.lastInsertRowid, mid);
    res.json({ id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put("/api/users/:id", auth, admin, (req, res) => {
  const { name, role, markets, password } = req.body;
  db.prepare("UPDATE users SET name=COALESCE(?,name), role=COALESCE(?,role) WHERE id=?").run(name, role, req.params.id);
  if (password) db.prepare("UPDATE users SET pass_hash=? WHERE id=?").run(hashPass(password), req.params.id);
  if (markets) {
    db.prepare("DELETE FROM user_markets WHERE user_id=?").run(req.params.id);
    for (const mid of markets) db.prepare("INSERT OR IGNORE INTO user_markets(user_id,market_id) VALUES(?,?)").run(req.params.id, mid);
  }
  res.json({ ok: true });
});
app.delete("/api/users/:id", auth, admin, (req, res) => {
  if (+req.params.id === req.user.id) return res.status(400).json({ error: "cannot delete yourself" });
  db.prepare("DELETE FROM users WHERE id=?").run(req.params.id);
  db.prepare("DELETE FROM user_markets WHERE user_id=?").run(req.params.id);
  db.prepare("DELETE FROM sessions WHERE user_id=?").run(req.params.id);
  res.json({ ok: true });
});

/* markets */
app.post("/api/markets", auth, admin, (req, res) => {
  const r = db.prepare("INSERT INTO markets(name,color) VALUES(?,?)").run(req.body.name, req.body.color || "#2563eb");
  res.json({ id: r.lastInsertRowid });
});
app.put("/api/markets/:marketId", auth, requireMarket, (req, res) => {
  const { name, color, settings } = req.body;
  if ((name || color) && req.user.role !== "admin") return res.status(403).json({ error: "admin only" });
  if (name) db.prepare("UPDATE markets SET name=? WHERE id=?").run(name, req.marketId);
  if (color) db.prepare("UPDATE markets SET color=? WHERE id=?").run(color, req.marketId);
  if (settings) {
    const cur = marketSettings(req.market);
    db.prepare("UPDATE markets SET settings_json=? WHERE id=?").run(JSON.stringify(Object.assign(cur, settings)), req.marketId);
  }
  res.json({ ok: true });
});
app.delete("/api/markets/:marketId", auth, admin, requireMarket, (req, res) => {
  for (const t of ["leads", "templates", "quick_replies", "campaigns", "messages"]) db.prepare(`DELETE FROM ${t} WHERE market_id=?`).run(req.marketId);
  db.prepare("DELETE FROM campaign_leads WHERE campaign_id IN (SELECT id FROM campaigns WHERE market_id=?)").run(req.marketId);
  db.prepare("DELETE FROM markets WHERE id=?").run(req.marketId);
  res.json({ ok: true });
});

/* leads */
app.get("/api/markets/:marketId/leads", auth, requireMarket, (req, res) => {
  const { q, status, tag, limit = 200, offset = 0 } = req.query;
  let sql = "SELECT * FROM leads WHERE market_id=?", args = [req.marketId];
  if (q) { sql += " AND (first_name LIKE ? OR last_name LIKE ? OR phone LIKE ? OR email LIKE ? OR address LIKE ?)"; const like = `%${q}%`; args.push(like, like, like, like, like); }
  if (status) { sql += " AND status=?"; args.push(status); }
  if (tag) { sql += " AND tags LIKE ?"; args.push(`%${tag}%`); }
  const total = db.prepare(sql.replace("SELECT *", "SELECT COUNT(*) c")).get(...args).c;
  const rows = db.prepare(sql + " ORDER BY id DESC LIMIT ? OFFSET ?").all(...args, +limit, +offset);
  res.json({ total, leads: rows });
});
app.post("/api/markets/:marketId/leads/import", auth, requireMarket, (req, res) => {
  const rows = req.body.rows || [];
  let added = 0, updated = 0, skipped = 0;
  const findByPhone = db.prepare("SELECT id FROM leads WHERE market_id=? AND phone=? AND phone!=''");
  const findByEmail = db.prepare("SELECT id FROM leads WHERE market_id=? AND email=? AND email!=''");
  const ins = db.prepare(`INSERT INTO leads(market_id,first_name,last_name,phone,email,address,city,state,zip,tags,status,custom_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  const tx = db.transaction(() => {
    for (const r of rows) {
      const phone = normPhone(r.phone), email = (r.email || "").trim().toLowerCase();
      if (!phone && !email) { skipped++; continue; }
      const existing = (phone && findByPhone.get(req.marketId, phone)) || (email && findByEmail.get(req.marketId, email));
      if (existing) { updated++; continue; }
      ins.run(req.marketId, r.first_name || "", r.last_name || "", phone, email, r.address || "", r.city || "", r.state || "", r.zip || "", r.tags || "", "new", JSON.stringify(r.custom || {}));
      added++;
    }
  });
  tx();
  res.json({ added, duplicates: updated, skipped });
});
app.put("/api/markets/:marketId/leads/:id", auth, requireMarket, (req, res) => {
  const fields = ["first_name", "last_name", "phone", "email", "address", "city", "state", "zip", "tags", "status", "notes"];
  const sets = [], args = [];
  for (const f of fields) if (req.body[f] !== undefined) { sets.push(`${f}=?`); args.push(f === "phone" ? normPhone(req.body[f]) : req.body[f]); }
  if (sets.length) db.prepare(`UPDATE leads SET ${sets.join(",")} WHERE id=? AND market_id=?`).run(...args, req.params.id, req.marketId);
  res.json({ ok: true });
});
app.post("/api/markets/:marketId/leads/bulk-delete", auth, requireMarket, (req, res) => {
  const ids = req.body.ids || [];
  const del = db.prepare("DELETE FROM leads WHERE id=? AND market_id=?");
  const tx = db.transaction(() => ids.forEach(id => del.run(id, req.marketId)));
  tx();
  res.json({ ok: true, deleted: ids.length });
});
app.get("/api/markets/:marketId/leads/:id", auth, requireMarket, (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id=? AND market_id=?").get(req.params.id, req.marketId);
  if (!lead) return res.status(404).json({ error: "not found" });
  lead.messages = db.prepare("SELECT * FROM messages WHERE lead_id=? ORDER BY created_at").all(lead.id);
  res.json(lead);
});

/* opt-outs */
app.get("/api/markets/:marketId/optouts", auth, requireMarket, (req, res) => {
  res.json(db.prepare("SELECT * FROM opt_outs WHERE market_id=? OR market_id IS NULL ORDER BY id DESC LIMIT 1000").all(req.marketId));
});
app.post("/api/markets/:marketId/optouts", auth, requireMarket, (req, res) => {
  const { channel, value, reason } = req.body;
  const v = channel === "sms" ? normPhone(value) : (value || "").toLowerCase().trim();
  if (!v) return res.status(400).json({ error: "invalid value" });
  db.prepare("INSERT INTO opt_outs(market_id,channel,value,reason) VALUES(?,?,?,?)").run(req.marketId, channel, v, reason || "manual");
  res.json({ ok: true });
});
app.delete("/api/markets/:marketId/optouts/:id", auth, requireMarket, (req, res) => {
  db.prepare("DELETE FROM opt_outs WHERE id=? AND market_id=?").run(req.params.id, req.marketId);
  res.json({ ok: true });
});
const isOptedOut = (channel, value) => !!db.prepare("SELECT 1 FROM opt_outs WHERE channel=? AND value=?").get(channel, value);

/* templates & quick replies */
app.get("/api/markets/:marketId/templates", auth, requireMarket, (req, res) =>
  res.json(db.prepare("SELECT * FROM templates WHERE market_id=? ORDER BY id DESC").all(req.marketId)));
app.post("/api/markets/:marketId/templates", auth, requireMarket, (req, res) => {
  const r = db.prepare("INSERT INTO templates(market_id,channel,name,subject,body) VALUES(?,?,?,?,?)").run(req.marketId, req.body.channel || "sms", req.body.name, req.body.subject || "", req.body.body);
  res.json({ id: r.lastInsertRowid });
});
app.put("/api/markets/:marketId/templates/:id", auth, requireMarket, (req, res) => {
  db.prepare("UPDATE templates SET name=?,subject=?,body=? WHERE id=? AND market_id=?").run(req.body.name, req.body.subject || "", req.body.body, req.params.id, req.marketId);
  res.json({ ok: true });
});
app.delete("/api/markets/:marketId/templates/:id", auth, requireMarket, (req, res) => {
  db.prepare("DELETE FROM templates WHERE id=? AND market_id=?").run(req.params.id, req.marketId);
  res.json({ ok: true });
});
app.get("/api/markets/:marketId/quick-replies", auth, requireMarket, (req, res) =>
  res.json(db.prepare("SELECT * FROM quick_replies WHERE market_id=?").all(req.marketId)));
app.post("/api/markets/:marketId/quick-replies", auth, requireMarket, (req, res) => {
  const r = db.prepare("INSERT INTO quick_replies(market_id,name,body) VALUES(?,?,?)").run(req.marketId, req.body.name, req.body.body);
  res.json({ id: r.lastInsertRowid });
});
app.delete("/api/markets/:marketId/quick-replies/:id", auth, requireMarket, (req, res) => {
  db.prepare("DELETE FROM quick_replies WHERE id=? AND market_id=?").run(req.params.id, req.marketId);
  res.json({ ok: true });
});

/* campaigns */
app.get("/api/markets/:marketId/campaigns", auth, requireMarket, (req, res) => {
  const rows = db.prepare("SELECT * FROM campaigns WHERE market_id=? ORDER BY id DESC").all(req.marketId);
  for (const c of rows) {
    const s = db.prepare("SELECT status, COUNT(*) c FROM campaign_leads WHERE campaign_id=? GROUP BY status").all(c.id);
    c.counts = Object.fromEntries(s.map(r => [r.status, r.c]));
    c.sent = db.prepare("SELECT COUNT(*) c FROM messages WHERE campaign_id=? AND direction='out' AND status NOT IN ('failed','queued')").get(c.id).c;
    c.replies = db.prepare("SELECT COUNT(DISTINCT lead_id) c FROM messages WHERE direction='in' AND lead_id IN (SELECT lead_id FROM campaign_leads WHERE campaign_id=?)").get(c.id).c;
    c.steps = JSON.parse(c.steps_json);
  }
  res.json(rows);
});
app.post("/api/markets/:marketId/campaigns", auth, requireMarket, (req, res) => {
  const { name, channel, steps, throttle_per_min, daily_cap } = req.body;
  const r = db.prepare("INSERT INTO campaigns(market_id,name,channel,steps_json,throttle_per_min,daily_cap) VALUES(?,?,?,?,?,?)")
    .run(req.marketId, name, channel || "sms", JSON.stringify(steps || []), throttle_per_min || 20, daily_cap || 2000);
  res.json({ id: r.lastInsertRowid });
});
app.put("/api/markets/:marketId/campaigns/:id", auth, requireMarket, (req, res) => {
  const c = db.prepare("SELECT * FROM campaigns WHERE id=? AND market_id=?").get(req.params.id, req.marketId);
  if (!c) return res.status(404).json({ error: "not found" });
  const { name, steps, status, throttle_per_min, daily_cap } = req.body;
  db.prepare("UPDATE campaigns SET name=COALESCE(?,name), steps_json=COALESCE(?,steps_json), status=COALESCE(?,status), throttle_per_min=COALESCE(?,throttle_per_min), daily_cap=COALESCE(?,daily_cap) WHERE id=?")
    .run(name, steps ? JSON.stringify(steps) : null, status, throttle_per_min, daily_cap, c.id);
  res.json({ ok: true });
});
app.delete("/api/markets/:marketId/campaigns/:id", auth, requireMarket, (req, res) => {
  db.prepare("DELETE FROM campaigns WHERE id=? AND market_id=?").run(req.params.id, req.marketId);
  db.prepare("DELETE FROM campaign_leads WHERE campaign_id=?").run(req.params.id);
  res.json({ ok: true });
});
app.post("/api/markets/:marketId/campaigns/:id/enroll", auth, requireMarket, (req, res) => {
  const c = db.prepare("SELECT * FROM campaigns WHERE id=? AND market_id=?").get(req.params.id, req.marketId);
  if (!c) return res.status(404).json({ error: "not found" });
  const { lead_ids, filter } = req.body;
  let leads;
  if (lead_ids && lead_ids.length) {
    leads = db.prepare(`SELECT * FROM leads WHERE market_id=? AND id IN (${lead_ids.map(() => "?").join(",")})`).all(req.marketId, ...lead_ids);
  } else {
    let sql = "SELECT * FROM leads WHERE market_id=?", args = [req.marketId];
    if (filter?.status) { sql += " AND status=?"; args.push(filter.status); }
    if (filter?.tag) { sql += " AND tags LIKE ?"; args.push(`%${filter.tag}%`); }
    leads = db.prepare(sql).all(...args);
  }
  let enrolled = 0, blocked = 0;
  const ins = db.prepare("INSERT OR IGNORE INTO campaign_leads(campaign_id,lead_id,step,next_send_at,status) VALUES(?,?,0,datetime('now'),'active')");
  const tx = db.transaction(() => {
    for (const l of leads) {
      const target = c.channel === "sms" ? l.phone : l.email;
      if (!target || isOptedOut(c.channel, target)) { blocked++; continue; }
      if (ins.run(c.id, l.id).changes > 0) enrolled++;
    }
  });
  tx();
  res.json({ enrolled, blocked });
});

/* inbox */
app.get("/api/markets/:marketId/inbox", auth, requireMarket, (req, res) => {
  const convos = db.prepare(`
    SELECT m.lead_id, MAX(m.created_at) last_at,
      SUM(CASE WHEN m.direction='in' AND m.read=0 THEN 1 ELSE 0 END) unread
    FROM messages m WHERE m.market_id=? AND m.channel='sms' AND m.lead_id IS NOT NULL
    GROUP BY m.lead_id ORDER BY last_at DESC LIMIT 300`).all(req.marketId);
  const out = [];
  for (const c of convos) {
    const lead = db.prepare("SELECT * FROM leads WHERE id=?").get(c.lead_id);
    const last = db.prepare("SELECT * FROM messages WHERE lead_id=? AND channel='sms' ORDER BY created_at DESC, id DESC LIMIT 1").get(c.lead_id);
    out.push({ lead, last, unread: c.unread });
  }
  res.json(out);
});
app.get("/api/markets/:marketId/inbox/:leadId", auth, requireMarket, (req, res) => {
  db.prepare("UPDATE messages SET read=1 WHERE lead_id=? AND direction='in'").run(req.params.leadId);
  res.json(db.prepare("SELECT * FROM messages WHERE lead_id=? ORDER BY created_at, id").all(req.params.leadId));
});
app.post("/api/markets/:marketId/inbox/:leadId/reply", auth, requireMarket, async (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id=? AND market_id=?").get(req.params.leadId, req.marketId);
  if (!lead || !lead.phone) return res.status(400).json({ error: "lead has no phone" });
  if (isOptedOut("sms", lead.phone)) return res.status(400).json({ error: "lead is opted out" });
  const ms = marketSettings(req.market);
  const lastOut = db.prepare("SELECT from_addr FROM messages WHERE lead_id=? AND direction='out' AND channel='sms' ORDER BY id DESC LIMIT 1").get(lead.id);
  const from = (lastOut && ms.from_numbers.includes(lastOut.from_addr)) ? lastOut.from_addr : ms.from_numbers[0];
  if (!from) return res.status(400).json({ error: "no phone numbers configured for this market" });
  const body = merge(req.body.body || "", lead);
  const mid = db.prepare("INSERT INTO messages(market_id,lead_id,direction,channel,from_addr,to_addr,body,status,user_id) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(req.marketId, lead.id, "out", "sms", from, lead.phone, body, "sending", req.user.id).lastInsertRowid;
  try {
    const sid = await twilioSend(from, lead.phone, body);
    db.prepare("UPDATE messages SET status='sent', provider_id=? WHERE id=?").run(sid, mid);
    res.json({ ok: true });
  } catch (e) {
    db.prepare("UPDATE messages SET status='failed', error=? WHERE id=?").run(e.message, mid);
    res.status(500).json({ error: e.message });
  }
});

/* ----------------------------- reporting ------------------------------ */
function pct(num, den) {
  if (!den) return null;
  return Math.round((1000 * num) / den) / 10;
}
function rangeSpec(range) {
  const key = range === "7d" || range === "month" ? range : "30d";
  const label = key === "7d" ? "Last 7 days" : key === "month" ? "This month" : "Last 30 days";
  function where(col) {
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(col)) throw new Error("bad column");
    if (key === "month") return { sql: `strftime('%Y-%m', ${col}) = strftime('%Y-%m', 'now')`, args: [] };
    return { sql: `${col} >= datetime('now', ?)`, args: [key === "7d" ? "-7 days" : "-30 days"] };
  }
  return { key, label, where };
}
function bucketDates(key) {
  const now = new Date();
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = key === "month"
    ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    : end - (key === "7d" ? 7 : 30) * 86400000;
  const out = [];
  for (let t = start; t <= end; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
const OUTBOUND_OK = "status NOT IN ('failed','queued')";
function buildMarketReport(mid, spec) {
  const w = spec.where("created_at");
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN direction='out' AND ${OUTBOUND_OK} THEN 1 ELSE 0 END), 0) AS sent,
      COALESCE(SUM(CASE WHEN direction='out' AND channel='sms' AND ${OUTBOUND_OK} THEN 1 ELSE 0 END), 0) AS sms_sent,
      COALESCE(SUM(CASE WHEN direction='out' AND channel='email' AND ${OUTBOUND_OK} THEN 1 ELSE 0 END), 0) AS email_sent,
      COALESCE(SUM(CASE WHEN direction='out' AND status='delivered' THEN 1 ELSE 0 END), 0) AS delivered,
      COALESCE(SUM(CASE WHEN direction='out' AND status='failed' THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(CASE WHEN direction='in' THEN 1 ELSE 0 END), 0) AS replies,
      COUNT(DISTINCT CASE WHEN direction='in' AND lead_id IS NOT NULL THEN lead_id END) AS unique_replies
    FROM messages
    WHERE market_id=? AND ${w.sql}
  `).get(mid, ...w.args);
  const n = k => Number(row && row[k] || 0);
  const sent = n("sent"), delivered = n("delivered"), failed = n("failed");
  const replies = n("replies"), unique = n("unique_replies");
  const opt_outs = db.prepare(`SELECT COUNT(*) c FROM opt_outs WHERE market_id=? AND ${w.sql}`).get(mid, ...w.args).c;
  const leads_added = db.prepare(`SELECT COUNT(*) c FROM leads WHERE market_id=? AND ${w.sql}`).get(mid, ...w.args).c;
  const today = new Date().toISOString().slice(0, 10);
  const g = (sql, ...a) => db.prepare(sql).get(...a).c;
  const snapshot = {
    leads: g("SELECT COUNT(*) c FROM leads WHERE market_id=?", mid),
    hot: g("SELECT COUNT(*) c FROM leads WHERE market_id=? AND status='hot'", mid),
    unread: g("SELECT COUNT(*) c FROM messages WHERE market_id=? AND direction='in' AND read=0", mid),
    active_campaigns: g("SELECT COUNT(*) c FROM campaigns WHERE market_id=? AND status='running'", mid),
    sent_today: g(`SELECT COUNT(*) c FROM messages WHERE market_id=? AND direction='out' AND date(created_at)=? AND ${OUTBOUND_OK}`, mid, today)
  };
  const byDay = db.prepare(`
    SELECT date(created_at) AS d,
      COALESCE(SUM(CASE WHEN direction='out' AND ${OUTBOUND_OK} THEN 1 ELSE 0 END), 0) AS sent,
      COALESCE(SUM(CASE WHEN direction='out' AND status='delivered' THEN 1 ELSE 0 END), 0) AS delivered,
      COALESCE(SUM(CASE WHEN direction='in' THEN 1 ELSE 0 END), 0) AS replies
    FROM messages WHERE market_id=? AND ${w.sql}
    GROUP BY date(created_at)
  `).all(mid, ...w.args);
  const ooDay = db.prepare(`
    SELECT date(created_at) AS d, COUNT(*) AS c
    FROM opt_outs WHERE market_id=? AND ${w.sql}
    GROUP BY date(created_at)
  `).all(mid, ...w.args);
  const sentMap = Object.fromEntries(byDay.map(r => [r.d, r]));
  const ooByDay = Object.fromEntries(ooDay.map(r => [r.d, r.c]));
  const daily = bucketDates(spec.key).map(d => ({
    date: d,
    sent: Number(sentMap[d] ? sentMap[d].sent : 0),
    delivered: Number(sentMap[d] ? sentMap[d].delivered : 0),
    replies: Number(sentMap[d] ? sentMap[d].replies : 0),
    opt_outs: Number(ooByDay[d] || 0)
  }));

  const cw = spec.where("m.created_at");
  const camps = db.prepare(`
    SELECT c.id, c.name, c.channel, c.status,
      COALESCE(SUM(CASE WHEN m.id IS NOT NULL AND m.direction='out' AND m.status NOT IN ('failed','queued') THEN 1 ELSE 0 END), 0) AS sent,
      COALESCE(SUM(CASE WHEN m.id IS NOT NULL AND m.direction='out' AND m.status='delivered' THEN 1 ELSE 0 END), 0) AS delivered,
      COALESCE(SUM(CASE WHEN m.id IS NOT NULL AND m.direction='out' AND m.status='failed' THEN 1 ELSE 0 END), 0) AS failed
    FROM campaigns c
    LEFT JOIN messages m ON m.campaign_id=c.id AND ${cw.sql}
    WHERE c.market_id=?
    GROUP BY c.id
    ORDER BY sent DESC, c.id DESC
  `).all(...cw.args, mid);
  const rw = spec.where("m.created_at");
  const replyRows = db.prepare(`
    SELECT cl.campaign_id AS id,
      COUNT(m.id) AS replies,
      COUNT(DISTINCT m.lead_id) AS unique_replies
    FROM campaign_leads cl
    JOIN messages m ON m.lead_id=cl.lead_id AND m.market_id=? AND m.direction='in' AND ${rw.sql}
    GROUP BY cl.campaign_id
  `).all(mid, ...rw.args);
  const replyMap = Object.fromEntries(replyRows.map(r => [r.id, r]));
  const ow = spec.where("o.created_at");
  const ooRows = db.prepare(`
    SELECT cl.campaign_id AS id, COUNT(DISTINCT o.id) AS opt_outs
    FROM campaign_leads cl
    JOIN campaigns c ON c.id=cl.campaign_id
    JOIN leads l ON l.id=cl.lead_id
    JOIN opt_outs o ON o.channel=c.channel
      AND o.value != ''
      AND o.value = CASE WHEN c.channel='sms' THEN l.phone ELSE lower(l.email) END
      AND o.market_id=c.market_id
      AND ${ow.sql}
    WHERE c.market_id=?
    GROUP BY cl.campaign_id
  `).all(...ow.args, mid);
  const ooMap = Object.fromEntries(ooRows.map(r => [r.id, r.opt_outs]));
  const enrollRows = db.prepare(`
    SELECT cl.campaign_id AS id, COUNT(*) AS enrolled
    FROM campaign_leads cl
    JOIN campaigns c ON c.id=cl.campaign_id
    WHERE c.market_id=?
    GROUP BY cl.campaign_id
  `).all(mid);
  const enrollMap = Object.fromEntries(enrollRows.map(r => [r.id, r.enrolled]));
  const campaigns = camps.map(c => {
    const sentN = Number(c.sent || 0);
    const deliveredN = Number(c.delivered || 0);
    const uniqueN = Number(replyMap[c.id] ? replyMap[c.id].unique_replies : 0);
    const repliesN = Number(replyMap[c.id] ? replyMap[c.id].replies : 0);
    const optN = Number(ooMap[c.id] || 0);
    return {
      id: c.id, name: c.name, channel: c.channel, status: c.status,
      enrolled: Number(enrollMap[c.id] || 0),
      sent: sentN, delivered: deliveredN, failed: Number(c.failed || 0),
      replies: repliesN, unique_replies: uniqueN, opt_outs: optN,
      reply_rate: pct(uniqueN, sentN), delivery_rate: pct(deliveredN, sentN)
    };
  });

  const uw = spec.where("m.created_at");
  const reps = db.prepare(`
    SELECT u.id, u.name, u.role,
      COALESCE(SUM(CASE WHEN m.id IS NOT NULL AND m.direction='out' AND m.status NOT IN ('failed','queued') THEN 1 ELSE 0 END), 0) AS sent,
      COALESCE(SUM(CASE WHEN m.id IS NOT NULL AND m.direction='out' AND m.status='delivered' THEN 1 ELSE 0 END), 0) AS delivered
    FROM users u
    LEFT JOIN messages m ON m.user_id=u.id AND m.market_id=? AND ${uw.sql}
    WHERE u.role='admin' OR u.id IN (SELECT user_id FROM user_markets WHERE market_id=?)
    GROUP BY u.id
    ORDER BY sent DESC, u.name COLLATE NOCASE
  `).all(mid, ...uw.args, mid).map(r => ({
    id: r.id, name: r.name, role: r.role,
    sent: Number(r.sent || 0), delivered: Number(r.delivered || 0),
    delivery_rate: pct(Number(r.delivered || 0), Number(r.sent || 0))
  }));
  const unW = spec.where("created_at");
  const un = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN ${OUTBOUND_OK} THEN 1 ELSE 0 END), 0) AS sent,
      COALESCE(SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END), 0) AS delivered
    FROM messages
    WHERE market_id=? AND user_id IS NULL AND direction='out' AND ${unW.sql}
  `).get(mid, ...unW.args);
  const pipeline = db.prepare("SELECT status, COUNT(*) c FROM leads WHERE market_id=? GROUP BY status ORDER BY c DESC").all(mid)
    .map(r => ({ status: r.status, count: r.c }));
  const marketRow = db.prepare("SELECT * FROM markets WHERE id=?").get(mid);

  return {
    range: spec.key,
    label: spec.label,
    definitions: {
      sent: "Outbound messages created in the range, excluding queued and failed.",
      reply_rate: "Unique leads with an inbound message in the range, divided by sends.",
      opt_outs: "Opt-out rows created for this market in the range.",
      reps: "Inbox replies store the sender. Campaign engine sends stay unattributed."
    },
    kpis: {
      sent, sms_sent: n("sms_sent"), email_sent: n("email_sent"),
      delivered, failed, replies, unique_replies: unique, opt_outs, leads_added,
      reply_rate: pct(unique, sent),
      delivery_rate: pct(delivered, sent),
      opt_out_rate: pct(opt_outs, sent)
    },
    snapshot,
    funnel: [
      { key: "sent", label: "Sent", value: sent, rate: sent ? 100 : null },
      { key: "delivered", label: "Delivered", value: delivered, rate: pct(delivered, sent) },
      { key: "replies", label: "Replied", value: unique, rate: pct(unique, sent) },
      { key: "opt_outs", label: "Opted out", value: opt_outs, rate: pct(opt_outs, sent) }
    ],
    daily,
    campaigns,
    reps,
    unattributed: { sent: Number(un && un.sent || 0), delivered: Number(un && un.delivered || 0) },
    pipeline,
    compliance: marketRow ? marketCompliance(marketRow) : null
  };
}

/* ------------------------ compliance checklist ------------------------ */
function marketCompliance(market) {
  const ms = marketSettings(market);
  const publicUrl = String(getSetting("public_url") || "").trim().replace(/\/$/, "");
  const hasTwilio = !!(getSetting("twilio_sid") && getSetting("twilio_token"));
  const start = Number(ms.quiet_start), end = Number(ms.quiet_end);
  const quietOk = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= 24 && start < end;
  const cap = Number(ms.daily_sms_cap);
  const capOk = Number.isFinite(cap) && cap > 0;
  const numbers = (ms.from_numbers || []).map(n => String(n).trim()).filter(Boolean);
  const perNumber = numbers.length && capOk ? Math.round(cap / numbers.length) : null;
  const tz = Number(ms.tz_offset);
  const tzLabel = "UTC" + (tz >= 0 ? "+" : "") + (Number.isFinite(tz) ? tz : "?");
  const pad = n => String(n).padStart(2, "0");
  let publicState = "warn";
  let publicDetail = "Set Integrations → Public URL to the https address of this server so inbound texts and delivery receipts can reach it.";
  if (/^https:\/\//i.test(publicUrl)) {
    publicState = "pass";
    publicDetail = "Inbound webhook: " + publicUrl + "/webhooks/twilio/sms";
  } else if (/^http:\/\//i.test(publicUrl)) {
    publicDetail = "Public URL is http. Use https in production so Twilio can deliver webhooks.";
  }
  const checks = [
    {
      id: "quiet_hours", label: "Quiet hours", state: quietOk ? "pass" : "warn",
      detail: quietOk
        ? `SMS sends only between ${pad(start)}:00 and ${pad(end)}:00 local (${tzLabel}).`
        : "Set a sending window with start earlier than end. An inverted window blocks every hour."
    },
    {
      id: "stop", label: "STOP / opt-out", state: "pass",
      detail: "STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, and QUIT are saved to the opt-out list, the lead is marked DNC, and sequences halt."
    },
    {
      id: "caps", label: "Daily SMS cap", state: capOk ? "pass" : "warn",
      detail: capOk ? `${cap.toLocaleString()} SMS/day for this market, plus each campaign's own daily cap.` : "Set a market daily SMS cap above 0."
    },
    {
      id: "pacing", label: "Number pacing",
      state: !numbers.length || !capOk ? "warn" : perNumber > 250 ? "warn" : "pass",
      detail: !numbers.length
        ? "Add at least one sending number before judging per-number volume."
        : !capOk
          ? "Set a daily cap to judge per-number volume."
          : perNumber > 250
            ? `About ${perNumber.toLocaleString()} SMS/day per number at this cap. Many teams stay near 150–200 to protect deliverability.`
            : `About ${perNumber.toLocaleString()} SMS/day per number at this cap.`
    },
    {
      id: "numbers", label: "Sending numbers", state: numbers.length ? "pass" : "warn",
      detail: numbers.length
        ? `${numbers.length} number${numbers.length === 1 ? "" : "s"} in this market's pool. Outbound SMS round-robins across them.`
        : "Add Twilio numbers in Market Setup, one E.164 number per line."
    },
    { id: "public_url", label: "Public URL / webhooks", state: publicState, detail: publicDetail },
    {
      id: "twilio", label: "Twilio credentials", state: hasTwilio ? "pass" : "warn",
      detail: hasTwilio ? "Account SID and auth token are saved." : "An admin needs to add Twilio credentials under Integrations."
    },
    {
      id: "email_unsub", label: "Email unsubscribe", state: "pass",
      detail: "Cold email adds an unsubscribe link and a List-Unsubscribe header. Clicks are written to the opt-out list."
    }
  ];
  return {
    market_id: market.id, name: market.name, color: market.color, checks,
    passing: checks.filter(c => c.state === "pass").length, total: checks.length
  };
}

const A2P_DOCS = {
  a2p: "https://www.twilio.com/docs/messaging/compliance/a2p-10dlc",
  console: "https://console.twilio.com/us1/develop/sms/regulatory-compliance",
  brands: "https://console.twilio.com/us1/develop/sms/regulatory-compliance/brands",
  campaigns: "https://console.twilio.com/us1/develop/sms/regulatory-compliance/campaigns",
  services: "https://console.twilio.com/us1/develop/sms/services",
  numbers: "https://console.twilio.com/us1/develop/phone-numbers/manage/incoming"
};
const A2P_DISCLAIMER = "Lariat reads Brand and Campaign status from Twilio. Registration and approval stay in the Twilio Console — this app does not submit or approve 10DLC brands or campaigns.";

function complianceShell() {
  const publicUrl = String(getSetting("public_url") || "").trim().replace(/\/$/, "");
  return {
    configured: !!(getSetting("twilio_sid") && getSetting("twilio_token")),
    public_url: publicUrl,
    webhook_url: publicUrl ? publicUrl + "/webhooks/twilio/sms" : "",
    status_callback_url: publicUrl ? publicUrl + "/webhooks/twilio/status" : "",
    disclaimer: A2P_DISCLAIMER,
    docs: A2P_DOCS,
    brands: [],
    messaging_services: [],
    numbers: [],
    markets: db.prepare("SELECT * FROM markets ORDER BY id").all().map(marketCompliance),
    next_actions: [],
    errors: [],
    fetched_at: null
  };
}
function slimBrand(b) {
  return {
    sid: b.sid || "",
    status: b.status || "UNKNOWN",
    brand_type: b.brand_type || "",
    identity_status: b.identity_status || "",
    tcr_id: b.tcr_id || "",
    brand_score: b.brand_score == null ? null : b.brand_score,
    failure_reason: b.failure_reason || "",
    date_updated: b.date_updated || b.date_created || ""
  };
}
function slimCampaign(c) {
  const errors = Array.isArray(c.errors) ? c.errors.slice(0, 5).map(e => String(typeof e === "string" ? e : (e.description || e.message || "")).slice(0, 200)).filter(Boolean) : [];
  return {
    sid: c.sid || "",
    campaign_id: c.campaign_id || "",
    campaign_status: c.campaign_status || "UNKNOWN",
    usecase: c.us_app_to_person_usecase || "",
    description: String(c.description || "").slice(0, 280),
    brand_registration_sid: c.brand_registration_sid || "",
    messaging_service_sid: c.messaging_service_sid || "",
    has_embedded_links: !!c.has_embedded_links,
    has_embedded_phone: !!c.has_embedded_phone,
    errors
  };
}
function webhookState(actual, expected, inAccount) {
  if (!expected) return "no_public_url";
  if (!inAccount) return "not_in_account";
  if (!actual) return "mismatch";
  return normalizeUrl(actual) === normalizeUrl(expected) ? "match" : "mismatch";
}
function buildNextActions({ brands, services, numberAudit, publicUrl, errors }) {
  const actions = [];
  const authError = (errors || []).find(e => e.status === 401 || e.status === 403);
  if (authError) {
    actions.push({ level: "warn", title: "Twilio rejected these credentials", detail: authError.message || "Check the Account SID and Auth Token, then save and refresh.", href: "https://console.twilio.com/" });
    return actions;
  }
  const brandErr = (errors || []).some(e => e.scope === "brands");
  if (!brands.length && !brandErr) {
    actions.push({ level: "warn", title: "Register an A2P Brand", detail: "No Brand registration came back from Twilio. Create the business profile in the Twilio Console. Lariat cannot submit it for you.", href: A2P_DOCS.brands });
  }
  for (const b of brands) {
    const st = String(b.status || "").toUpperCase();
    if (st !== "APPROVED") {
      actions.push({ level: "warn", title: `Brand ${b.tcr_id || b.sid || ""} is ${st || "not approved"}`.trim(), detail: b.failure_reason || "Finish or correct this Brand in the Twilio Console. Approval is not done inside Lariat.", href: A2P_DOCS.brands });
    }
  }
  const campaigns = [];
  for (const s of services) for (const c of s.campaigns) campaigns.push(Object.assign({ service_name: s.friendly_name }, c));
  const campErr = (errors || []).some(e => e.scope === "campaigns" || e.scope === "services");
  if (!services.length && !(errors || []).some(e => e.scope === "services")) {
    actions.push({ level: "warn", title: "Create a Messaging Service", detail: "A2P campaigns attach to a Messaging Service. Create one in the Twilio Console and add this market's numbers to it.", href: A2P_DOCS.services });
  } else if (services.length && !campaigns.length && !campErr) {
    actions.push({ level: "warn", title: "Register a 10DLC campaign", detail: "A Messaging Service exists, but no Usa2p campaign is attached yet. Register the use case in the Twilio Console.", href: A2P_DOCS.campaigns });
  }
  for (const c of campaigns) {
    const st = String(c.campaign_status || "").toUpperCase();
    if (st && st !== "VERIFIED" && st !== "APPROVED") {
      actions.push({ level: "warn", title: `Campaign ${c.campaign_id || c.sid} is ${st}`, detail: (c.errors && c.errors[0]) || `${c.usecase || "Use case"} on ${c.service_name}. Review it in the Twilio Console.`, href: A2P_DOCS.campaigns });
    }
  }
  const looseNums = [...new Set(numberAudit.filter(n => !n.messaging_service_sid).map(n => n.phone_number))];
  if (looseNums.length) {
    actions.push({ level: "warn", title: `${looseNums.length} number${looseNums.length === 1 ? "" : "s"} not on a Messaging Service`, detail: `${looseNums.slice(0, 4).join(", ")}. Attach them to the service that carries your A2P campaign, or carriers may filter the traffic.`, href: A2P_DOCS.services });
  }
  const mismatch = numberAudit.filter(n => n.webhook === "mismatch");
  if (mismatch.length && publicUrl) {
    actions.push({ level: "warn", title: "Inbound webhook does not match Public URL", detail: `Point “A message comes in” at ${publicUrl}/webhooks/twilio/sms (HTTP POST), on each number or on the Messaging Service.`, href: A2P_DOCS.numbers });
  }
  if (!publicUrl) {
    actions.push({ level: "warn", title: "Set the Public URL", detail: "Integrations → Public URL should be the https address of this server. Lariat uses it for delivery receipts and shows the inbound webhook to paste into Twilio.", href: "" });
  }
  if (!actions.length) {
    actions.push({ level: "pass", title: "Registration looks ready to send", detail: "A Brand is approved, a campaign is on a Messaging Service, and market numbers are attached. Keep quiet hours, STOP handling, and daily caps on. Carrier throughput still follows the campaign Twilio approved.", href: A2P_DOCS.a2p });
  }
  return actions.slice(0, 12);
}
async function loadA2P() {
  const shell = complianceShell();
  const sid = getSetting("twilio_sid");
  const expectedHook = shell.webhook_url;
  const errors = [];
  let brands = [];
  let services = [];
  let incoming = [];
  try {
    brands = (await twilioCollect("https://messaging.twilio.com/v1/a2p/BrandRegistrations?PageSize=50", "data")).map(slimBrand);
  } catch (e) {
    errors.push({ scope: "brands", message: e.message, status: e.status || null });
  }
  try {
    const rawServices = await twilioCollect("https://messaging.twilio.com/v1/Services?PageSize=50", "services");
    for (const s of rawServices.slice(0, 15)) {
      let campaigns = [];
      let numbers = [];
      try {
        campaigns = (await twilioCollect(`https://messaging.twilio.com/v1/Services/${encodeURIComponent(s.sid)}/Compliance/Usa2p?PageSize=50`, "compliance")).map(slimCampaign);
      } catch (e) {
        errors.push({ scope: "campaigns", service: s.sid, message: e.message, status: e.status || null });
      }
      try {
        numbers = (await twilioCollect(`https://messaging.twilio.com/v1/Services/${encodeURIComponent(s.sid)}/PhoneNumbers?PageSize=100`, "phone_numbers")).map(p => ({
          sid: p.sid || "", phone_number: p.phone_number || ""
        }));
      } catch (e) {
        errors.push({ scope: "service_numbers", service: s.sid, message: e.message, status: e.status || null });
      }
      const inbound = s.inbound_request_url || "";
      services.push({
        sid: s.sid,
        friendly_name: s.friendly_name || s.sid,
        us_app_to_person_registered: !!s.us_app_to_person_registered,
        inbound_request_url: inbound,
        inbound_webhook: webhookState(inbound, expectedHook, true),
        status_callback: s.status_callback || "",
        campaigns,
        phone_numbers: numbers
      });
    }
  } catch (e) {
    errors.push({ scope: "services", message: e.message, status: e.status || null });
  }
  try {
    incoming = await twilioCollect(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/IncomingPhoneNumbers.json?PageSize=200`, "incoming_phone_numbers");
  } catch (e) {
    errors.push({ scope: "numbers", message: e.message, status: e.status || null });
  }

  const attached = new Map();
  for (const s of services) for (const p of s.phone_numbers) {
    const key = normPhone(p.phone_number) || String(p.phone_number || "").trim();
    if (key) attached.set(key, { service_sid: s.sid, service_name: s.friendly_name });
  }
  const incomingByNum = new Map();
  for (const n of incoming) {
    const key = normPhone(n.phone_number) || String(n.phone_number || "").trim();
    if (key) incomingByNum.set(key, n);
  }
  const markets = db.prepare("SELECT * FROM markets ORDER BY id").all();
  const numberAudit = [];
  for (const m of markets) {
    const ms = marketSettings(m);
    for (const raw of ms.from_numbers || []) {
      const num = normPhone(raw) || String(raw).trim();
      if (!num) continue;
      const inc = incomingByNum.get(num);
      const att = attached.get(num);
      const smsUrl = inc ? (inc.sms_url || "") : "";
      numberAudit.push({
        phone_number: num,
        market_id: m.id,
        market_name: m.name,
        market_color: m.color,
        messaging_service_sid: att ? att.service_sid : "",
        messaging_service_name: att ? att.service_name : "",
        in_account: !!inc,
        sms_url: smsUrl,
        webhook: webhookState(smsUrl, expectedHook, !!inc)
      });
    }
  }
  shell.brands = brands;
  shell.messaging_services = services;
  shell.numbers = numberAudit;
  shell.errors = errors;
  shell.next_actions = buildNextActions({ brands, services, numberAudit, publicUrl: shell.public_url, errors });
  shell.fetched_at = new Date().toISOString();
  return shell;
}
function unconfiguredA2P() {
  const shell = complianceShell();
  const hook = shell.webhook_url;
  shell.next_actions = [
    { level: "warn", title: "Add Twilio credentials", detail: "Paste the Account SID and Auth Token above and save. Lariat will then read Brand, Campaign, and Messaging Service status. It will not register them for you.", href: "https://console.twilio.com/" },
    { level: "info", title: "Register in the Twilio Console", detail: "Brand and Campaign approval happens in Twilio Regulatory Compliance. This screen only displays the status afterward.", href: A2P_DOCS.console },
    { level: "info", title: "Point webhooks at this server", detail: hook ? `Set “A message comes in” to ${hook} (HTTP POST).` : "Set Public URL first, then use /webhooks/twilio/sms as the Twilio inbound webhook.", href: A2P_DOCS.a2p }
  ];
  return shell;
}

/* stats */
function marketStats(mid) {
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const g = (sql, ...a) => db.prepare(sql).get(...a).c;
  return {
    leads: g("SELECT COUNT(*) c FROM leads WHERE market_id=?", mid),
    sent_today: g("SELECT COUNT(*) c FROM messages WHERE market_id=? AND direction='out' AND date(created_at)=? AND status NOT IN('failed')", mid, today),
    sent_month: g("SELECT COUNT(*) c FROM messages WHERE market_id=? AND direction='out' AND strftime('%Y-%m',created_at)=? AND status NOT IN('failed')", mid, month),
    sms_month: g("SELECT COUNT(*) c FROM messages WHERE market_id=? AND direction='out' AND channel='sms' AND strftime('%Y-%m',created_at)=? AND status NOT IN('failed')", mid, month),
    email_month: g("SELECT COUNT(*) c FROM messages WHERE market_id=? AND direction='out' AND channel='email' AND strftime('%Y-%m',created_at)=? AND status NOT IN('failed')", mid, month),
    delivered_month: g("SELECT COUNT(*) c FROM messages WHERE market_id=? AND direction='out' AND strftime('%Y-%m',created_at)=? AND status='delivered'", mid, month),
    failed_month: g("SELECT COUNT(*) c FROM messages WHERE market_id=? AND direction='out' AND strftime('%Y-%m',created_at)=? AND status='failed'", mid, month),
    replies_month: g("SELECT COUNT(*) c FROM messages WHERE market_id=? AND direction='in' AND strftime('%Y-%m',created_at)=?", mid, month),
    unread: g("SELECT COUNT(*) c FROM messages WHERE market_id=? AND direction='in' AND read=0", mid),
    opt_outs: g("SELECT COUNT(*) c FROM opt_outs WHERE market_id=?", mid),
    hot: g("SELECT COUNT(*) c FROM leads WHERE market_id=? AND status='hot'", mid),
    active_campaigns: g("SELECT COUNT(*) c FROM campaigns WHERE market_id=? AND status='running'", mid)
  };
}
app.get("/api/markets/:marketId/stats", auth, requireMarket, (req, res) => res.json(marketStats(req.marketId)));
app.get("/api/overview", auth, (req, res) => {
  const mids = userMarketIds(req.user);
  const out = mids.map(mid => {
    const m = db.prepare("SELECT * FROM markets WHERE id=?").get(mid);
    return { market: { id: m.id, name: m.name, color: m.color }, stats: marketStats(mid) };
  });
  res.json(out);
});
app.get("/api/markets/:marketId/reports", auth, requireMarket, (req, res) => {
  try { res.json(buildMarketReport(req.marketId, rangeSpec(req.query.range))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/reports/overview", auth, (req, res) => {
  try {
    const spec = rangeSpec(req.query.range);
    const markets = userMarketIds(req.user).map(mid => {
      const m = db.prepare("SELECT id, name, color FROM markets WHERE id=?").get(mid);
      if (!m) return null;
      const report = buildMarketReport(mid, spec);
      return { market: m, kpis: report.kpis, snapshot: report.snapshot };
    }).filter(Boolean);
    const sum = k => markets.reduce((a, r) => a + Number(r.kpis[k] || 0), 0);
    const sent = sum("sent");
    res.json({
      range: spec.key,
      label: spec.label,
      totals: {
        sent, sms_sent: sum("sms_sent"), email_sent: sum("email_sent"),
        delivered: sum("delivered"), failed: sum("failed"),
        replies: sum("replies"), unique_replies: sum("unique_replies"),
        opt_outs: sum("opt_outs"), leads_added: sum("leads_added"),
        leads: markets.reduce((a, r) => a + Number(r.snapshot.leads || 0), 0),
        reply_rate: pct(sum("unique_replies"), sent),
        delivery_rate: pct(sum("delivered"), sent),
        opt_out_rate: pct(sum("opt_outs"), sent)
      },
      markets
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* global settings (admin) */
app.get("/api/settings", auth, admin, (req, res) => {
  const keys = ["twilio_sid", "twilio_token", "sendgrid_key", "smtp_json", "public_url"];
  res.json(Object.fromEntries(keys.map(k => [k, getSetting(k) || ""])));
});
app.put("/api/settings", auth, admin, (req, res) => {
  for (const [k, v] of Object.entries(req.body)) setSetting(k, v);
  a2pCache = null;
  res.json({ ok: true });
});
app.get("/api/markets/:marketId/compliance", auth, requireMarket, (req, res) => {
  res.json(marketCompliance(req.market));
});
app.get("/api/compliance/a2p", auth, admin, async (req, res) => {
  if (!getSetting("twilio_sid") || !getSetting("twilio_token")) return res.json(unconfiguredA2P());
  try {
    const force = req.query.refresh === "1";
    if (!force && a2pCache && Date.now() - a2pCache.at < 60 * 1000) return res.json(a2pCache.data);
    const data = await loadA2P();
    a2pCache = { at: Date.now(), data };
    res.json(data);
  } catch (e) {
    const shell = complianceShell();
    shell.errors = [{ scope: "a2p", message: e.message || "Could not reach Twilio" }];
    shell.next_actions = [{ level: "warn", title: "Could not read A2P status", detail: e.message || "Twilio did not respond. Check the credentials and refresh.", href: "https://console.twilio.com/" }];
    shell.fetched_at = new Date().toISOString();
    res.json(shell);
  }
});
app.get("/api/export", auth, admin, (req, res) => {
  const dump = {};
  for (const t of ["markets", "leads", "opt_outs", "templates", "quick_replies", "campaigns", "campaign_leads", "messages"])
    dump[t] = db.prepare(`SELECT * FROM ${t}`).all();
  res.setHeader("Content-Disposition", `attachment; filename=lariat-backup-${new Date().toISOString().slice(0, 10)}.json`);
  res.json(dump);
});

/* ------------------------- Twilio webhooks ----------------------------- */
const STOP_WORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|remove)\b/i;
app.post("/webhooks/twilio/sms", (req, res) => {
  const from = normPhone(req.body.From), to = normPhone(req.body.To), body = req.body.Body || "";
  // which market owns the receiving number?
  let market = null;
  for (const m of db.prepare("SELECT * FROM markets").all())
    if (marketSettings(m).from_numbers.includes(to)) { market = m; break; }
  const mid = market ? market.id : (db.prepare("SELECT id FROM markets ORDER BY id LIMIT 1").get() || {}).id;
  if (mid) {
    let lead = db.prepare("SELECT * FROM leads WHERE market_id=? AND phone=?").get(mid, from);
    if (!lead) {
      const lid = db.prepare("INSERT INTO leads(market_id,first_name,phone,status,tags) VALUES(?,?,?,?,?)").run(mid, "Unknown", from, "new", "inbound").lastInsertRowid;
      lead = { id: lid };
    }
    db.prepare("INSERT INTO messages(market_id,lead_id,direction,channel,from_addr,to_addr,body,status) VALUES(?,?,?,?,?,?,?,?)")
      .run(mid, lead.id, "in", "sms", from, to, body, "received");
    // pause their sequences on reply
    db.prepare("UPDATE campaign_leads SET status='replied' WHERE lead_id=? AND status='active'").run(lead.id);
    if (STOP_WORDS.test(body)) {
      db.prepare("INSERT INTO opt_outs(market_id,channel,value,reason) VALUES(?,?,?,?)").run(mid, "sms", from, "STOP reply");
      db.prepare("UPDATE campaign_leads SET status='opted_out' WHERE lead_id=?").run(lead.id);
      db.prepare("UPDATE leads SET status='dnc' WHERE id=?").run(lead.id);
    } else {
      db.prepare("UPDATE leads SET status=CASE WHEN status IN('new','contacted') THEN 'responded' ELSE status END WHERE id=?").run(lead.id);
    }
  }
  res.type("text/xml").send("<Response></Response>");
});
app.post("/webhooks/twilio/status", (req, res) => {
  const { MessageSid, MessageStatus } = req.body;
  if (MessageSid && ["delivered", "failed", "undelivered"].includes(MessageStatus))
    db.prepare("UPDATE messages SET status=? WHERE provider_id=?").run(MessageStatus === "undelivered" ? "failed" : MessageStatus, MessageSid);
  res.sendStatus(200);
});

/* email unsubscribe */
app.get("/u/:token", (req, res) => {
  try {
    const [mid, email] = Buffer.from(req.params.token, "base64url").toString().split("|");
    if (email) {
      db.prepare("INSERT INTO opt_outs(market_id,channel,value,reason) VALUES(?,?,?,?)").run(+mid || null, "email", email.toLowerCase(), "unsubscribe link");
      db.prepare("UPDATE campaign_leads SET status='opted_out' WHERE lead_id IN (SELECT id FROM leads WHERE email=?)").run(email.toLowerCase());
    }
    res.send("<html><body style='font-family:sans-serif;text-align:center;padding:60px'><h2>You've been unsubscribed.</h2><p>You won't receive any more emails from us.</p></body></html>");
  } catch { res.status(400).send("Invalid link"); }
});

/* --------------------------- QUEUE ENGINE ------------------------------ */
/* Ticks every 3 s. For each running campaign: respects quiet hours (market
   timezone), market daily cap, campaign daily cap, per-minute throttle,
   number-pool round-robin, opt-outs. Multi-step drip with per-step A/B
   template variants.                                                      */
const sendTimestamps = {}; // campaignId -> [epoch ms] for throttle window
let rrIndex = {};          // marketId -> round robin pointer

function localHour(tzOffset) {
  const now = new Date(Date.now() + tzOffset * 3600 * 1000);
  return now.getUTCHours();
}
async function queueTick() {
  const campaigns = db.prepare("SELECT * FROM campaigns WHERE status='running'").all();
  for (const c of campaigns) {
    try { await processCampaign(c); } catch (e) { console.error("campaign", c.id, e.message); }
  }
}
async function processCampaign(c) {
  const market = db.prepare("SELECT * FROM markets WHERE id=?").get(c.market_id);
  if (!market) return;
  const ms = marketSettings(market);
  const steps = JSON.parse(c.steps_json || "[]");
  if (!steps.length) return;

  // quiet hours (SMS only; email sends any time)
  if (c.channel === "sms") {
    const h = localHour(ms.tz_offset);
    if (h < ms.quiet_start || h >= ms.quiet_end) return;
  }
  // market daily cap
  const today = new Date().toISOString().slice(0, 10);
  const sentToday = db.prepare("SELECT COUNT(*) c FROM messages WHERE market_id=? AND direction='out' AND channel=? AND date(created_at)=?").get(c.market_id, c.channel, today).c;
  const cap = c.channel === "sms" ? ms.daily_sms_cap : (ms.daily_email_cap || 2000);
  if (sentToday >= cap) return;
  // campaign daily cap
  const campSentToday = db.prepare("SELECT COUNT(*) c FROM messages WHERE campaign_id=? AND direction='out' AND date(created_at)=?").get(c.id, today).c;
  if (campSentToday >= c.daily_cap) return;
  // throttle window
  const now = Date.now();
  sendTimestamps[c.id] = (sendTimestamps[c.id] || []).filter(t => now - t < 60000);
  const budget = Math.min(
    Math.max(0, (c.throttle_per_min || 20) - sendTimestamps[c.id].length),
    5, // max per tick keeps the loop responsive
    cap - sentToday, c.daily_cap - campSentToday
  );
  if (budget <= 0) return;

  const due = db.prepare("SELECT * FROM campaign_leads WHERE campaign_id=? AND status='active' AND next_send_at<=datetime('now') LIMIT ?").all(c.id, budget);
  for (const cl of due) {
    const lead = db.prepare("SELECT * FROM leads WHERE id=?").get(cl.lead_id);
    if (!lead) { db.prepare("UPDATE campaign_leads SET status='failed' WHERE id=?").run(cl.id); continue; }
    const target = c.channel === "sms" ? lead.phone : lead.email;
    if (!target || isOptedOut(c.channel, target) || lead.status === "dnc") {
      db.prepare("UPDATE campaign_leads SET status='opted_out' WHERE id=?").run(cl.id); continue;
    }
    const step = steps[cl.step];
    if (!step) { db.prepare("UPDATE campaign_leads SET status='completed' WHERE id=?").run(cl.id); continue; }
    const variants = step.variants && step.variants.length ? step.variants : [{ subject: step.subject, body: step.body }];
    const v = variants[Math.floor(Math.random() * variants.length)];
    const body = merge(v.body || "", lead);
    const subject = c.channel === "email" ? merge(v.subject || "", lead) : "";
    const mid = db.prepare("INSERT INTO messages(market_id,lead_id,campaign_id,direction,channel,to_addr,subject,body,status) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(c.market_id, lead.id, c.id, "out", c.channel, target, subject, body, "sending").lastInsertRowid;
    try {
      if (c.channel === "sms") {
        const pool = ms.from_numbers;
        if (!pool.length) throw new Error("no numbers in market pool");
        rrIndex[c.market_id] = ((rrIndex[c.market_id] || 0) + 1) % pool.length;
        const from = pool[rrIndex[c.market_id]];
        db.prepare("UPDATE messages SET from_addr=? WHERE id=?").run(from, mid);
        const sid = await twilioSend(from, target, body);
        db.prepare("UPDATE messages SET status='sent', provider_id=? WHERE id=?").run(sid, mid);
      } else {
        if (!ms.email_from) throw new Error("no From email set for market");
        const unsubToken = Buffer.from(`${c.market_id}|${target}`).toString("base64url");
        const base = getSetting("public_url") || `http://localhost:${PORT}`;
        const unsubUrl = `${base}/u/${unsubToken}`;
        const html = body.replace(/\n/g, "<br>") + `<br><br><p style="font-size:11px;color:#888">Don't want these? <a href="${unsubUrl}">Unsubscribe</a></p>`;
        db.prepare("UPDATE messages SET from_addr=? WHERE id=?").run(ms.email_from, mid);
        const pid = await emailSend({ fromName: ms.email_from_name, fromEmail: ms.email_from, to: target, subject, html, text: body + `\n\nUnsubscribe: ${unsubUrl}`, unsubUrl });
        db.prepare("UPDATE messages SET status='sent', provider_id=? WHERE id=?").run(String(pid), mid);
      }
      sendTimestamps[c.id].push(Date.now());
      // advance to next step or complete
      const nextStep = cl.step + 1;
      if (nextStep >= steps.length) {
        db.prepare("UPDATE campaign_leads SET status='completed', step=? WHERE id=?").run(nextStep, cl.id);
      } else {
        const delayDays = Math.max(0, +steps[nextStep].delay_days || 1);
        db.prepare("UPDATE campaign_leads SET step=?, next_send_at=datetime('now', ?) WHERE id=?").run(nextStep, `+${delayDays} days`, cl.id);
      }
      db.prepare("UPDATE leads SET status=CASE WHEN status='new' THEN 'contacted' ELSE status END WHERE id=?").run(lead.id);
    } catch (e) {
      db.prepare("UPDATE messages SET status='failed', error=? WHERE id=?").run(e.message, mid);
      db.prepare("UPDATE campaign_leads SET status='failed' WHERE id=?").run(cl.id);
    }
  }
  // auto-complete campaign when nothing left
  const remaining = db.prepare("SELECT COUNT(*) c FROM campaign_leads WHERE campaign_id=? AND status='active'").get(c.id).c;
  const total = db.prepare("SELECT COUNT(*) c FROM campaign_leads WHERE campaign_id=?").get(c.id).c;
  if (total > 0 && remaining === 0) db.prepare("UPDATE campaigns SET status='completed' WHERE id=?").run(c.id);
}
setInterval(() => { queueTick().catch(e => console.error("tick", e)); }, 3000);

/* SPA fallback */
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, "0.0.0.0", () => console.log(`Lariat Pro running on http://0.0.0.0:${PORT}`));
