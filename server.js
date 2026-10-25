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
    c.replies = db.prepare("SELECT COUNT(DISTINCT lead_id) c FROM messages WHERE campaign_id IS NOT NULL AND direction='in' AND lead_id IN (SELECT lead_id FROM campaign_leads WHERE campaign_id=?)").get(c.id).c;
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

/* global settings (admin) */
app.get("/api/settings", auth, admin, (req, res) => {
  const keys = ["twilio_sid", "twilio_token", "sendgrid_key", "smtp_json", "public_url"];
  res.json(Object.fromEntries(keys.map(k => [k, getSetting(k) || ""])));
});
app.put("/api/settings", auth, admin, (req, res) => {
  for (const [k, v] of Object.entries(req.body)) setSetting(k, v);
  res.json({ ok: true });
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

app.listen(PORT, () => console.log(`Lariat Pro running on http://localhost:${PORT}`));
