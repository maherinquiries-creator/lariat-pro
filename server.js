/* =========================================================================
   LARIAT PRO — multi-market SMS + cold-email outreach platform
   Node + Express. Postgres (DATABASE_URL / Supabase) with a SQLite fallback
   for local dev. Twilio for SMS, SendGrid (or any SMTP) for email.
   ========================================================================= */
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { openDatabase, initDatabase } = require("./db");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = path.join(DATA_DIR, "lariat.db");
const db = openDatabase({ dbPath: DB_PATH });
let a2pCache = null;

const ENV_FALLBACKS = {
  twilio_sid: "TWILIO_ACCOUNT_SID",
  twilio_token: "TWILIO_AUTH_TOKEN",
  sendgrid_key: "SENDGRID_API_KEY",
  public_url: "PUBLIC_URL"
};
const SECRET_KEYS = new Set(["twilio_token", "sendgrid_key"]);
const ENV_SECRET_MASK = "••••••••";
const STARTER_MARKETS = [["Land", "#16a34a"], ["Vegas Realtors", "#dc2626"], ["Homeowners", "#2563eb"], ["Dispo", "#9333ea"]];

/* ----------------------------- helpers -------------------------------- */
async function readSettingRow(k) {
  return db.get("SELECT value FROM settings WHERE key=?", k);
}
async function getSetting(k) {
  const row = await readSettingRow(k);
  if (row && row.value) return row.value;
  const envName = ENV_FALLBACKS[k];
  if (envName && process.env[envName]) return process.env[envName];
  return row && row.value != null ? row.value : null;
}
async function settingForApi(k) {
  const row = await readSettingRow(k);
  if (row && row.value) return row.value;
  const envName = ENV_FALLBACKS[k];
  const envVal = envName ? (process.env[envName] || "") : "";
  if (envVal && SECRET_KEYS.has(k)) return ENV_SECRET_MASK;
  if (envVal) return envVal;
  return "";
}
function isMaskedSecret(v) {
  return typeof v === "string" && (v === ENV_SECRET_MASK || v.startsWith("••••"));
}
async function setSetting(k, v) {
  await db.run(
    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    k, v == null ? "" : String(v)
  );
}
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

async function seedMarkets() {
  for (const [name, color] of STARTER_MARKETS) {
    const existing = await db.get("SELECT id FROM markets WHERE name=?", name);
    if (!existing) await db.run("INSERT INTO markets(name,color) VALUES(?,?)", name, color);
  }
}
async function seedAdmin() {
  const email = String(process.env.LARIAT_ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.LARIAT_ADMIN_PASSWORD || "";
  if (!email || !password) return;
  const existing = await db.get("SELECT id FROM users WHERE email=?", email);
  if (existing) return;
  await db.run(
    "INSERT INTO users(name,email,pass_hash,role) VALUES(?,?,?,'admin')",
    process.env.LARIAT_ADMIN_NAME || "Admin",
    email,
    hashPass(password)
  );
  console.log("Bootstrapped admin user for", email);
}

/* --------------------------- providers --------------------------------- */
async function twilioSend(from, to, body) {
  const sid = await getSetting("twilio_sid"), tok = await getSetting("twilio_token");
  if (!sid || !tok) throw new Error("Twilio not configured (Settings → Twilio)");
  const publicUrl = await getSetting("public_url");
  const cb = publicUrl ? `${publicUrl}/webhooks/twilio/status` : null;
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

async function twilioAuthHeader() {
  const sid = await getSetting("twilio_sid"), tok = await getSetting("twilio_token");
  if (!sid || !tok) return null;
  return "Basic " + Buffer.from(sid + ":" + tok).toString("base64");
}
async function twilioGet(url) {
  const auth = await twilioAuthHeader();
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
  const sgKey = await getSetting("sendgrid_key");
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
  const smtp = JSON.parse((await getSetting("smtp_json")) || "null");
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

function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/* auth */
async function auth(req, res, next) {
  try {
    const tok = (req.headers.authorization || "").replace("Bearer ", "") || req.query.token;
    const s = tok && await db.get("SELECT * FROM sessions WHERE token=?", tok);
    if (!s) return res.status(401).json({ error: "unauthorized" });
    req.user = await db.get("SELECT id,name,email,role FROM users WHERE id=?", s.user_id);
    if (!req.user) return res.status(401).json({ error: "unauthorized" });
    req.user.id = Number(req.user.id);
    next();
  } catch (e) { next(e); }
}
const admin = (req, res, next) => req.user.role === "admin" ? next() : res.status(403).json({ error: "admin only" });
async function userMarketIds(u) {
  if (u.role === "admin") return (await db.all("SELECT id FROM markets")).map(r => Number(r.id));
  return (await db.all("SELECT market_id FROM user_markets WHERE user_id=?", u.id)).map(r => Number(r.market_id));
}
async function requireMarket(req, res, next) {
  try {
    const mid = +(req.params.marketId || req.body.market_id || req.query.market_id);
    if (!(await userMarketIds(req.user)).includes(mid)) return res.status(403).json({ error: "no access to this market" });
    req.marketId = mid;
    req.market = await db.get("SELECT * FROM markets WHERE id=?", mid);
    if (!req.market) return res.status(404).json({ error: "not found" });
    next();
  } catch (e) { next(e); }
}

/* first-run: create admin */
app.get("/api/bootstrap", asyncHandler(async (req, res) => {
  const count = Number((await db.get("SELECT COUNT(*) c FROM users")).c);
  res.json({ needsSetup: count === 0 });
}));
app.post("/api/setup", asyncHandler(async (req, res) => {
  if (Number((await db.get("SELECT COUNT(*) c FROM users")).c) > 0) return res.status(400).json({ error: "already set up" });
  const { name, email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  await db.run("INSERT INTO users(name,email,pass_hash,role) VALUES(?,?,?,'admin')", name || "Admin", email.toLowerCase(), hashPass(password));
  await seedMarkets();
  res.json({ ok: true });
}));
app.post("/api/login", asyncHandler(async (req, res) => {
  const u = await db.get("SELECT * FROM users WHERE email=?", (req.body.email || "").toLowerCase());
  if (!u || !checkPass(req.body.password || "", u.pass_hash)) return res.status(401).json({ error: "bad email or password" });
  const token = crypto.randomBytes(24).toString("hex");
  await db.run("INSERT INTO sessions(token,user_id) VALUES(?,?)", token, u.id);
  res.json({ token, user: { id: Number(u.id), name: u.name, email: u.email, role: u.role }, markets: await userMarketIds(u) });
}));
app.post("/api/logout", auth, asyncHandler(async (req, res) => {
  await db.run("DELETE FROM sessions WHERE token=?", (req.headers.authorization || "").replace("Bearer ", ""));
  res.json({ ok: true });
}));
app.get("/api/me", auth, asyncHandler(async (req, res) => {
  const mids = await userMarketIds(req.user);
  const markets = await db.all(`SELECT * FROM markets WHERE id IN (${mids.map(() => "?").join(",") || "0"})`, ...mids);
  res.json({ user: req.user, markets: markets.map(m => ({ ...m, settings: marketSettings(m) })) });
}));

/* users (admin) */
app.get("/api/users", auth, admin, asyncHandler(async (req, res) => {
  const users = await db.all("SELECT id,name,email,role,created_at FROM users");
  for (const u of users) u.markets = (await db.all("SELECT market_id FROM user_markets WHERE user_id=?", u.id)).map(r => Number(r.market_id));
  res.json(users);
}));
app.post("/api/users", auth, admin, asyncHandler(async (req, res) => {
  const { name, email, password, role, markets } = req.body;
  try {
    const info = await db.run("INSERT INTO users(name,email,pass_hash,role) VALUES(?,?,?,?)", name, email.toLowerCase(), hashPass(password), role === "admin" ? "admin" : "rep");
    for (const mid of markets || []) await db.run("INSERT OR IGNORE INTO user_markets(user_id,market_id) VALUES(?,?)", info.lastInsertRowid, mid);
    res.json({ id: info.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
app.put("/api/users/:id", auth, admin, asyncHandler(async (req, res) => {
  const { name, role, markets, password } = req.body;
  await db.run("UPDATE users SET name=COALESCE(?,name), role=COALESCE(?,role) WHERE id=?", name, role, req.params.id);
  if (password) await db.run("UPDATE users SET pass_hash=? WHERE id=?", hashPass(password), req.params.id);
  if (markets) {
    await db.run("DELETE FROM user_markets WHERE user_id=?", req.params.id);
    for (const mid of markets) await db.run("INSERT OR IGNORE INTO user_markets(user_id,market_id) VALUES(?,?)", req.params.id, mid);
  }
  res.json({ ok: true });
}));
app.delete("/api/users/:id", auth, admin, asyncHandler(async (req, res) => {
  if (+req.params.id === req.user.id) return res.status(400).json({ error: "cannot delete yourself" });
  await db.run("DELETE FROM users WHERE id=?", req.params.id);
  await db.run("DELETE FROM user_markets WHERE user_id=?", req.params.id);
  await db.run("DELETE FROM sessions WHERE user_id=?", req.params.id);
  res.json({ ok: true });
}));

/* markets */
app.post("/api/markets", auth, admin, asyncHandler(async (req, res) => {
  const info = await db.run("INSERT INTO markets(name,color) VALUES(?,?)", req.body.name, req.body.color || "#2563eb");
  res.json({ id: info.lastInsertRowid });
}));
app.put("/api/markets/:marketId", auth, requireMarket, asyncHandler(async (req, res) => {
  const { name, color, settings } = req.body;
  if ((name || color) && req.user.role !== "admin") return res.status(403).json({ error: "admin only" });
  if (name) await db.run("UPDATE markets SET name=? WHERE id=?", name, req.marketId);
  if (color) await db.run("UPDATE markets SET color=? WHERE id=?", color, req.marketId);
  if (settings) {
    const cur = marketSettings(req.market);
    await db.run("UPDATE markets SET settings_json=? WHERE id=?", JSON.stringify(Object.assign(cur, settings)), req.marketId);
  }
  res.json({ ok: true });
}));
app.delete("/api/markets/:marketId", auth, admin, requireMarket, asyncHandler(async (req, res) => {
  await db.run("DELETE FROM campaign_leads WHERE campaign_id IN (SELECT id FROM campaigns WHERE market_id=?)", req.marketId);
  for (const t of ["leads", "templates", "quick_replies", "campaigns", "messages"]) await db.run(`DELETE FROM ${t} WHERE market_id=?`, req.marketId);
  await db.run("DELETE FROM markets WHERE id=?", req.marketId);
  res.json({ ok: true });
}));

/* leads */
app.get("/api/markets/:marketId/leads", auth, requireMarket, asyncHandler(async (req, res) => {
  const { q, status, tag, limit = 200, offset = 0 } = req.query;
  let sql = "SELECT * FROM leads WHERE market_id=?", args = [req.marketId];
  if (q) { sql += " AND (first_name LIKE ? OR last_name LIKE ? OR phone LIKE ? OR email LIKE ? OR address LIKE ?)"; const like = `%${q}%`; args.push(like, like, like, like, like); }
  if (status) { sql += " AND status=?"; args.push(status); }
  if (tag) { sql += " AND tags LIKE ?"; args.push(`%${tag}%`); }
  const total = Number((await db.get(sql.replace("SELECT *", "SELECT COUNT(*) c"), ...args)).c);
  const rows = await db.all(sql + " ORDER BY id DESC LIMIT ? OFFSET ?", ...args, +limit, +offset);
  res.json({ total, leads: rows });
}));
app.post("/api/markets/:marketId/leads/import", auth, requireMarket, asyncHandler(async (req, res) => {
  const rows = req.body.rows || [];
  let added = 0, updated = 0, skipped = 0;
  await db.transaction(async (tx) => {
    for (const r of rows) {
      const phone = normPhone(r.phone), email = (r.email || "").trim().toLowerCase();
      if (!phone && !email) { skipped++; continue; }
      const existing = (phone && await tx.get("SELECT id FROM leads WHERE market_id=? AND phone=? AND phone!=''", req.marketId, phone))
        || (email && await tx.get("SELECT id FROM leads WHERE market_id=? AND email=? AND email!=''", req.marketId, email));
      if (existing) { updated++; continue; }
      await tx.run("INSERT INTO leads(market_id,first_name,last_name,phone,email,address,city,state,zip,tags,status,custom_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        req.marketId, r.first_name || "", r.last_name || "", phone, email, r.address || "", r.city || "", r.state || "", r.zip || "", r.tags || "", "new", JSON.stringify(r.custom || {}));
      added++;
    }
  });
  res.json({ added, duplicates: updated, skipped });
}));
app.put("/api/markets/:marketId/leads/:id", auth, requireMarket, asyncHandler(async (req, res) => {
  const fields = ["first_name", "last_name", "phone", "email", "address", "city", "state", "zip", "tags", "status", "notes"];
  const sets = [], args = [];
  for (const f of fields) if (req.body[f] !== undefined) { sets.push(`${f}=?`); args.push(f === "phone" ? normPhone(req.body[f]) : req.body[f]); }
  if (sets.length) await db.run(`UPDATE leads SET ${sets.join(",")} WHERE id=? AND market_id=?`, ...args, req.params.id, req.marketId);
  res.json({ ok: true });
}));
app.post("/api/markets/:marketId/leads/bulk-delete", auth, requireMarket, asyncHandler(async (req, res) => {
  const ids = req.body.ids || [];
  await db.transaction(async (tx) => {
    for (const id of ids) await tx.run("DELETE FROM leads WHERE id=? AND market_id=?", id, req.marketId);
  });
  res.json({ ok: true, deleted: ids.length });
}));
app.get("/api/markets/:marketId/leads/:id", auth, requireMarket, asyncHandler(async (req, res) => {
  const lead = await db.get("SELECT * FROM leads WHERE id=? AND market_id=?", req.params.id, req.marketId);
  if (!lead) return res.status(404).json({ error: "not found" });
  lead.messages = await db.all("SELECT * FROM messages WHERE lead_id=? ORDER BY created_at", lead.id);
  res.json(lead);
}));

/* opt-outs */
app.get("/api/markets/:marketId/optouts", auth, requireMarket, asyncHandler(async (req, res) => {
  res.json(await db.all("SELECT * FROM opt_outs WHERE market_id=? OR market_id IS NULL ORDER BY id DESC LIMIT 1000", req.marketId));
}));
app.post("/api/markets/:marketId/optouts", auth, requireMarket, asyncHandler(async (req, res) => {
  const { channel, value, reason } = req.body;
  const v = channel === "sms" ? normPhone(value) : (value || "").toLowerCase().trim();
  if (!v) return res.status(400).json({ error: "invalid value" });
  await db.run("INSERT INTO opt_outs(market_id,channel,value,reason) VALUES(?,?,?,?)", req.marketId, channel, v, reason || "manual");
  res.json({ ok: true });
}));
app.delete("/api/markets/:marketId/optouts/:id", auth, requireMarket, asyncHandler(async (req, res) => {
  await db.run("DELETE FROM opt_outs WHERE id=? AND market_id=?", req.params.id, req.marketId);
  res.json({ ok: true });
}));
const isOptedOut = async (channel, value) => !!(await db.get("SELECT 1 FROM opt_outs WHERE channel=? AND value=?", channel, value));

/* templates & quick replies */
app.get("/api/markets/:marketId/templates", auth, requireMarket, asyncHandler(async (req, res) =>
  res.json(await db.all("SELECT * FROM templates WHERE market_id=? ORDER BY id DESC", req.marketId))));
app.post("/api/markets/:marketId/templates", auth, requireMarket, asyncHandler(async (req, res) => {
  const info = await db.run("INSERT INTO templates(market_id,channel,name,subject,body) VALUES(?,?,?,?,?)", req.marketId, req.body.channel || "sms", req.body.name, req.body.subject || "", req.body.body);
  res.json({ id: info.lastInsertRowid });
}));
app.put("/api/markets/:marketId/templates/:id", auth, requireMarket, asyncHandler(async (req, res) => {
  await db.run("UPDATE templates SET name=?,subject=?,body=? WHERE id=? AND market_id=?", req.body.name, req.body.subject || "", req.body.body, req.params.id, req.marketId);
  res.json({ ok: true });
}));
app.delete("/api/markets/:marketId/templates/:id", auth, requireMarket, asyncHandler(async (req, res) => {
  await db.run("DELETE FROM templates WHERE id=? AND market_id=?", req.params.id, req.marketId);
  res.json({ ok: true });
}));
app.get("/api/markets/:marketId/quick-replies", auth, requireMarket, asyncHandler(async (req, res) =>
  res.json(await db.all("SELECT * FROM quick_replies WHERE market_id=?", req.marketId))));
app.post("/api/markets/:marketId/quick-replies", auth, requireMarket, asyncHandler(async (req, res) => {
  const info = await db.run("INSERT INTO quick_replies(market_id,name,body) VALUES(?,?,?)", req.marketId, req.body.name, req.body.body);
  res.json({ id: info.lastInsertRowid });
}));
app.delete("/api/markets/:marketId/quick-replies/:id", auth, requireMarket, asyncHandler(async (req, res) => {
  await db.run("DELETE FROM quick_replies WHERE id=? AND market_id=?", req.params.id, req.marketId);
  res.json({ ok: true });
}));

/* campaigns */
app.get("/api/markets/:marketId/campaigns", auth, requireMarket, asyncHandler(async (req, res) => {
  const rows = await db.all("SELECT * FROM campaigns WHERE market_id=? ORDER BY id DESC", req.marketId);
  for (const c of rows) {
    const s = await db.all("SELECT status, COUNT(*) c FROM campaign_leads WHERE campaign_id=? GROUP BY status", c.id);
    c.counts = Object.fromEntries(s.map(r => [r.status, Number(r.c)]));
    c.sent = Number((await db.get("SELECT COUNT(*) c FROM messages WHERE campaign_id=? AND direction='out' AND status NOT IN ('failed','queued')", c.id)).c);
    c.replies = Number((await db.get("SELECT COUNT(DISTINCT lead_id) c FROM messages WHERE direction='in' AND lead_id IN (SELECT lead_id FROM campaign_leads WHERE campaign_id=?)", c.id)).c);
    c.steps = JSON.parse(c.steps_json);
  }
  res.json(rows);
}));
app.post("/api/markets/:marketId/campaigns", auth, requireMarket, asyncHandler(async (req, res) => {
  const { name, channel, steps, throttle_per_min, daily_cap } = req.body;
  const info = await db.run("INSERT INTO campaigns(market_id,name,channel,steps_json,throttle_per_min,daily_cap) VALUES(?,?,?,?,?,?)",
    req.marketId, name, channel || "sms", JSON.stringify(steps || []), throttle_per_min || 20, daily_cap || 2000);
  res.json({ id: info.lastInsertRowid });
}));
app.put("/api/markets/:marketId/campaigns/:id", auth, requireMarket, asyncHandler(async (req, res) => {
  const c = await db.get("SELECT * FROM campaigns WHERE id=? AND market_id=?", req.params.id, req.marketId);
  if (!c) return res.status(404).json({ error: "not found" });
  const { name, steps, status, throttle_per_min, daily_cap } = req.body;
  await db.run("UPDATE campaigns SET name=COALESCE(?,name), steps_json=COALESCE(?,steps_json), status=COALESCE(?,status), throttle_per_min=COALESCE(?,throttle_per_min), daily_cap=COALESCE(?,daily_cap) WHERE id=?",
    name, steps ? JSON.stringify(steps) : null, status, throttle_per_min, daily_cap, c.id);
  res.json({ ok: true });
}));
app.delete("/api/markets/:marketId/campaigns/:id", auth, requireMarket, asyncHandler(async (req, res) => {
  await db.run("DELETE FROM campaign_leads WHERE campaign_id=?", req.params.id);
  await db.run("DELETE FROM campaigns WHERE id=? AND market_id=?", req.params.id, req.marketId);
  res.json({ ok: true });
}));
app.post("/api/markets/:marketId/campaigns/:id/enroll", auth, requireMarket, asyncHandler(async (req, res) => {
  const c = await db.get("SELECT * FROM campaigns WHERE id=? AND market_id=?", req.params.id, req.marketId);
  if (!c) return res.status(404).json({ error: "not found" });
  const { lead_ids, filter } = req.body;
  let leads;
  if (lead_ids && lead_ids.length) {
    leads = await db.all(`SELECT * FROM leads WHERE market_id=? AND id IN (${lead_ids.map(() => "?").join(",")})`, req.marketId, ...lead_ids);
  } else {
    let sql = "SELECT * FROM leads WHERE market_id=?", args = [req.marketId];
    if (filter && filter.status) { sql += " AND status=?"; args.push(filter.status); }
    if (filter && filter.tag) { sql += " AND tags LIKE ?"; args.push(`%${filter.tag}%`); }
    leads = await db.all(sql, ...args);
  }
  let enrolled = 0, blocked = 0;
  await db.transaction(async (tx) => {
    for (const l of leads) {
      const target = c.channel === "sms" ? l.phone : l.email;
      if (!target || await isOptedOut(c.channel, target)) { blocked++; continue; }
      const info = await tx.run("INSERT OR IGNORE INTO campaign_leads(campaign_id,lead_id,step,next_send_at,status) VALUES(?,?,0,datetime('now'),'active')", c.id, l.id);
      if (info.changes > 0) enrolled++;
    }
  });
  res.json({ enrolled, blocked });
}));

/* inbox */
app.get("/api/markets/:marketId/inbox", auth, requireMarket, asyncHandler(async (req, res) => {
  const convos = await db.all(`
    SELECT m.lead_id, MAX(m.created_at) last_at,
      SUM(CASE WHEN m.direction='in' AND m.read=0 THEN 1 ELSE 0 END) unread
    FROM messages m WHERE m.market_id=? AND m.channel='sms' AND m.lead_id IS NOT NULL
    GROUP BY m.lead_id ORDER BY last_at DESC LIMIT 300`, req.marketId);
  const out = [];
  for (const c of convos) {
    const lead = await db.get("SELECT * FROM leads WHERE id=?", c.lead_id);
    const last = await db.get("SELECT * FROM messages WHERE lead_id=? AND channel='sms' ORDER BY created_at DESC, id DESC LIMIT 1", c.lead_id);
    out.push({ lead, last, unread: Number(c.unread) });
  }
  res.json(out);
}));
app.get("/api/markets/:marketId/inbox/:leadId", auth, requireMarket, asyncHandler(async (req, res) => {
  await db.run("UPDATE messages SET read=1 WHERE lead_id=? AND direction='in'", req.params.leadId);
  res.json(await db.all("SELECT * FROM messages WHERE lead_id=? ORDER BY created_at, id", req.params.leadId));
}));
app.post("/api/markets/:marketId/inbox/:leadId/reply", auth, requireMarket, asyncHandler(async (req, res) => {
  const lead = await db.get("SELECT * FROM leads WHERE id=? AND market_id=?", req.params.leadId, req.marketId);
  if (!lead || !lead.phone) return res.status(400).json({ error: "lead has no phone" });
  if (await isOptedOut("sms", lead.phone)) return res.status(400).json({ error: "lead is opted out" });
  const ms = marketSettings(req.market);
  const lastOut = await db.get("SELECT from_addr FROM messages WHERE lead_id=? AND direction='out' AND channel='sms' ORDER BY id DESC LIMIT 1", lead.id);
  const from = (lastOut && ms.from_numbers.includes(lastOut.from_addr)) ? lastOut.from_addr : ms.from_numbers[0];
  if (!from) return res.status(400).json({ error: "no phone numbers configured for this market" });
  const body = merge(req.body.body || "", lead);
  const info = await db.run("INSERT INTO messages(market_id,lead_id,direction,channel,from_addr,to_addr,body,status,user_id) VALUES(?,?,?,?,?,?,?,?,?)",
    req.marketId, lead.id, "out", "sms", from, lead.phone, body, "sending", req.user.id);
  try {
    const sid = await twilioSend(from, lead.phone, body);
    await db.run("UPDATE messages SET status='sent', provider_id=? WHERE id=?", sid, info.lastInsertRowid);
    res.json({ ok: true });
  } catch (e) {
    await db.run("UPDATE messages SET status='failed', error=? WHERE id=?", e.message, info.lastInsertRowid);
    res.status(500).json({ error: e.message });
  }
}));

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
function dayKey(v) {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
const OUTBOUND_OK = "status NOT IN ('failed','queued')";
async function buildMarketReport(mid, spec) {
  const w = spec.where("created_at");
  const row = await db.get(`
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
  `, mid, ...w.args);
  const n = k => Number(row && row[k] || 0);
  const sent = n("sent"), delivered = n("delivered"), failed = n("failed");
  const replies = n("replies"), unique = n("unique_replies");
  const opt_outs = Number((await db.get(`SELECT COUNT(*) c FROM opt_outs WHERE market_id=? AND ${w.sql}`, mid, ...w.args)).c);
  const leads_added = Number((await db.get(`SELECT COUNT(*) c FROM leads WHERE market_id=? AND ${w.sql}`, mid, ...w.args)).c);
  const today = new Date().toISOString().slice(0, 10);
  const g = async (sql, ...a) => Number((await db.get(sql, ...a)).c);
  const snapshot = {
    leads: await g("SELECT COUNT(*) c FROM leads WHERE market_id=?", mid),
    hot: await g("SELECT COUNT(*) c FROM leads WHERE market_id=? AND status='hot'", mid),
    unread: await g("SELECT COUNT(*) c FROM messages WHERE market_id=? AND direction='in' AND read=0", mid),
    active_campaigns: await g("SELECT COUNT(*) c FROM campaigns WHERE market_id=? AND status='running'", mid),
    sent_today: await g(`SELECT COUNT(*) c FROM messages WHERE market_id=? AND direction='out' AND date(created_at)=? AND ${OUTBOUND_OK}`, mid, today)
  };
  const byDay = await db.all(`
    SELECT date(created_at) AS d,
      COALESCE(SUM(CASE WHEN direction='out' AND ${OUTBOUND_OK} THEN 1 ELSE 0 END), 0) AS sent,
      COALESCE(SUM(CASE WHEN direction='out' AND status='delivered' THEN 1 ELSE 0 END), 0) AS delivered,
      COALESCE(SUM(CASE WHEN direction='in' THEN 1 ELSE 0 END), 0) AS replies
    FROM messages WHERE market_id=? AND ${w.sql}
    GROUP BY date(created_at)
  `, mid, ...w.args);
  const ooDay = await db.all(`
    SELECT date(created_at) AS d, COUNT(*) AS c
    FROM opt_outs WHERE market_id=? AND ${w.sql}
    GROUP BY date(created_at)
  `, mid, ...w.args);
  const sentMap = Object.fromEntries(byDay.map(r => [dayKey(r.d), r]));
  const ooByDay = Object.fromEntries(ooDay.map(r => [dayKey(r.d), Number(r.c)]));
  const daily = bucketDates(spec.key).map(d => ({
    date: d,
    sent: Number(sentMap[d] ? sentMap[d].sent : 0),
    delivered: Number(sentMap[d] ? sentMap[d].delivered : 0),
    replies: Number(sentMap[d] ? sentMap[d].replies : 0),
    opt_outs: Number(ooByDay[d] || 0)
  }));

  const cw = spec.where("m.created_at");
  const camps = await db.all(`
    SELECT c.id, c.name, c.channel, c.status,
      COALESCE(SUM(CASE WHEN m.id IS NOT NULL AND m.direction='out' AND m.status NOT IN ('failed','queued') THEN 1 ELSE 0 END), 0) AS sent,
      COALESCE(SUM(CASE WHEN m.id IS NOT NULL AND m.direction='out' AND m.status='delivered' THEN 1 ELSE 0 END), 0) AS delivered,
      COALESCE(SUM(CASE WHEN m.id IS NOT NULL AND m.direction='out' AND m.status='failed' THEN 1 ELSE 0 END), 0) AS failed
    FROM campaigns c
    LEFT JOIN messages m ON m.campaign_id=c.id AND ${cw.sql}
    WHERE c.market_id=?
    GROUP BY c.id
    ORDER BY sent DESC, c.id DESC
  `, ...cw.args, mid);
  const rw = spec.where("m.created_at");
  const replyRows = await db.all(`
    SELECT cl.campaign_id AS id,
      COUNT(m.id) AS replies,
      COUNT(DISTINCT m.lead_id) AS unique_replies
    FROM campaign_leads cl
    JOIN messages m ON m.lead_id=cl.lead_id AND m.market_id=? AND m.direction='in' AND ${rw.sql}
    GROUP BY cl.campaign_id
  `, mid, ...rw.args);
  const replyMap = Object.fromEntries(replyRows.map(r => [r.id, r]));
  const ow = spec.where("o.created_at");
  const ooRows = await db.all(`
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
  `, ...ow.args, mid);
  const ooMap = Object.fromEntries(ooRows.map(r => [r.id, r.opt_outs]));
  const enrollRows = await db.all(`
    SELECT cl.campaign_id AS id, COUNT(*) AS enrolled
    FROM campaign_leads cl
    JOIN campaigns c ON c.id=cl.campaign_id
    WHERE c.market_id=?
    GROUP BY cl.campaign_id
  `, mid);
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
  const reps = (await db.all(`
    SELECT u.id, u.name, u.role,
      COALESCE(SUM(CASE WHEN m.id IS NOT NULL AND m.direction='out' AND m.status NOT IN ('failed','queued') THEN 1 ELSE 0 END), 0) AS sent,
      COALESCE(SUM(CASE WHEN m.id IS NOT NULL AND m.direction='out' AND m.status='delivered' THEN 1 ELSE 0 END), 0) AS delivered
    FROM users u
    LEFT JOIN messages m ON m.user_id=u.id AND m.market_id=? AND ${uw.sql}
    WHERE u.role='admin' OR u.id IN (SELECT user_id FROM user_markets WHERE market_id=?)
    GROUP BY u.id
    ORDER BY sent DESC, lower(u.name)
  `, mid, ...uw.args, mid)).map(r => ({
    id: r.id, name: r.name, role: r.role,
    sent: Number(r.sent || 0), delivered: Number(r.delivered || 0),
    delivery_rate: pct(Number(r.delivered || 0), Number(r.sent || 0))
  }));
  const unW = spec.where("created_at");
  const un = await db.get(`
    SELECT
      COALESCE(SUM(CASE WHEN ${OUTBOUND_OK} THEN 1 ELSE 0 END), 0) AS sent,
      COALESCE(SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END), 0) AS delivered
    FROM messages
    WHERE market_id=? AND user_id IS NULL AND direction='out' AND ${unW.sql}
  `, mid, ...unW.args);
  const pipeline = (await db.all("SELECT status, COUNT(*) c FROM leads WHERE market_id=? GROUP BY status ORDER BY c DESC", mid))
    .map(r => ({ status: r.status, count: Number(r.c) }));
  const marketRow = await db.get("SELECT * FROM markets WHERE id=?", mid);

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
    compliance: marketRow ? await marketCompliance(marketRow) : null
  };
}

/* ------------------------ compliance checklist ------------------------ */
async function marketCompliance(market) {
  const ms = marketSettings(market);
  const publicUrl = String((await getSetting("public_url")) || "").trim().replace(/\/$/, "");
  const hasTwilio = !!((await getSetting("twilio_sid")) && (await getSetting("twilio_token")));
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

async function complianceShell() {
  const publicUrl = String((await getSetting("public_url")) || "").trim().replace(/\/$/, "");
  const markets = await db.all("SELECT * FROM markets ORDER BY id");
  return {
    configured: !!((await getSetting("twilio_sid")) && (await getSetting("twilio_token"))),
    public_url: publicUrl,
    webhook_url: publicUrl ? publicUrl + "/webhooks/twilio/sms" : "",
    status_callback_url: publicUrl ? publicUrl + "/webhooks/twilio/status" : "",
    disclaimer: A2P_DISCLAIMER,
    docs: A2P_DOCS,
    brands: [],
    messaging_services: [],
    numbers: [],
    markets: await Promise.all(markets.map(marketCompliance)),
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
  const shell = await complianceShell();
  const sid = await getSetting("twilio_sid");
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
  const markets = await db.all("SELECT * FROM markets ORDER BY id");
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
async function unconfiguredA2P() {
  const shell = await complianceShell();
  const hook = shell.webhook_url;
  shell.next_actions = [
    { level: "warn", title: "Add Twilio credentials", detail: "Paste the Account SID and Auth Token above and save. Lariat will then read Brand, Campaign, and Messaging Service status. It will not register them for you.", href: "https://console.twilio.com/" },
    { level: "info", title: "Register in the Twilio Console", detail: "Brand and Campaign approval happens in Twilio Regulatory Compliance. This screen only displays the status afterward.", href: A2P_DOCS.console },
    { level: "info", title: "Point webhooks at this server", detail: hook ? `Set “A message comes in” to ${hook} (HTTP POST).` : "Set Public URL first, then use /webhooks/twilio/sms as the Twilio inbound webhook.", href: A2P_DOCS.a2p }
  ];
  return shell;
}

/* stats */
async function marketStats(mid) {
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const g = async (sql, ...a) => Number((await db.get(sql, ...a)).c);
  return {
    leads: await g("SELECT COUNT(*) c FROM leads WHERE market_id=?", mid),
    sent_today: await g("SELECT COUNT(*) c FROM messages WHERE market_id=? AND direction='out' AND date(created_at)=? AND status NOT IN('failed')", mid, today),
    sent_month: await g("SELECT COUNT(*) c FROM messages WHERE market_id=? AND direction='out' AND strftime('%Y-%m',created_at)=? AND status NOT IN('failed')", mid, month),
    sms_month: await g("SELECT COUNT(*) c FROM messages WHERE market_id=? AND direction='out' AND channel='sms' AND strftime('%Y-%m',created_at)=? AND status NOT IN('failed')", mid, month),
    email_month: await g("SELECT COUNT(*) c FROM messages WHERE market_id=? AND direction='out' AND channel='email' AND strftime('%Y-%m',created_at)=? AND status NOT IN('failed')", mid, month),
    delivered_month: await g("SELECT COUNT(*) c FROM messages WHERE market_id=? AND direction='out' AND strftime('%Y-%m',created_at)=? AND status='delivered'", mid, month),
    failed_month: await g("SELECT COUNT(*) c FROM messages WHERE market_id=? AND direction='out' AND strftime('%Y-%m',created_at)=? AND status='failed'", mid, month),
    replies_month: await g("SELECT COUNT(*) c FROM messages WHERE market_id=? AND direction='in' AND strftime('%Y-%m',created_at)=?", mid, month),
    unread: await g("SELECT COUNT(*) c FROM messages WHERE market_id=? AND direction='in' AND read=0", mid),
    opt_outs: await g("SELECT COUNT(*) c FROM opt_outs WHERE market_id=?", mid),
    hot: await g("SELECT COUNT(*) c FROM leads WHERE market_id=? AND status='hot'", mid),
    active_campaigns: await g("SELECT COUNT(*) c FROM campaigns WHERE market_id=? AND status='running'", mid)
  };
}
app.get("/api/markets/:marketId/stats", auth, requireMarket, asyncHandler(async (req, res) => res.json(await marketStats(req.marketId))));
app.get("/api/overview", auth, asyncHandler(async (req, res) => {
  const mids = await userMarketIds(req.user);
  const out = [];
  for (const mid of mids) {
    const m = await db.get("SELECT * FROM markets WHERE id=?", mid);
    if (!m) continue;
    out.push({ market: { id: m.id, name: m.name, color: m.color }, stats: await marketStats(mid) });
  }
  res.json(out);
}));
app.get("/api/markets/:marketId/reports", auth, requireMarket, asyncHandler(async (req, res) => {
  res.json(await buildMarketReport(req.marketId, rangeSpec(req.query.range)));
}));
app.get("/api/reports/overview", auth, asyncHandler(async (req, res) => {
  const spec = rangeSpec(req.query.range);
  const markets = [];
  for (const mid of await userMarketIds(req.user)) {
    const m = await db.get("SELECT id, name, color FROM markets WHERE id=?", mid);
    if (!m) continue;
    const report = await buildMarketReport(mid, spec);
    markets.push({ market: m, kpis: report.kpis, snapshot: report.snapshot });
  }
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
}));

/* global settings (admin) */
app.get("/api/settings", auth, admin, asyncHandler(async (req, res) => {
  const keys = ["twilio_sid", "twilio_token", "sendgrid_key", "smtp_json", "public_url"];
  const out = {};
  for (const k of keys) out[k] = await settingForApi(k);
  res.json(out);
}));
app.put("/api/settings", auth, admin, asyncHandler(async (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) {
    if (SECRET_KEYS.has(k) && isMaskedSecret(v)) continue;
    await setSetting(k, v);
  }
  a2pCache = null;
  res.json({ ok: true });
}));
app.get("/api/markets/:marketId/compliance", auth, requireMarket, asyncHandler(async (req, res) => {
  res.json(await marketCompliance(req.market));
}));
app.get("/api/compliance/a2p", auth, admin, asyncHandler(async (req, res) => {
  if (!(await getSetting("twilio_sid")) || !(await getSetting("twilio_token"))) return res.json(await unconfiguredA2P());
  try {
    const force = req.query.refresh === "1";
    if (!force && a2pCache && Date.now() - a2pCache.at < 60 * 1000) return res.json(a2pCache.data);
    const data = await loadA2P();
    a2pCache = { at: Date.now(), data };
    res.json(data);
  } catch (e) {
    const shell = await complianceShell();
    shell.errors = [{ scope: "a2p", message: e.message || "Could not reach Twilio" }];
    shell.next_actions = [{ level: "warn", title: "Could not read A2P status", detail: e.message || "Twilio did not respond. Check the credentials and refresh.", href: "https://console.twilio.com/" }];
    shell.fetched_at = new Date().toISOString();
    res.json(shell);
  }
}));
app.get("/api/export", auth, admin, asyncHandler(async (req, res) => {
  const dump = {};
  for (const t of ["markets", "leads", "opt_outs", "templates", "quick_replies", "campaigns", "campaign_leads", "messages"])
    dump[t] = await db.all(`SELECT * FROM ${t}`);
  res.setHeader("Content-Disposition", `attachment; filename=lariat-backup-${new Date().toISOString().slice(0, 10)}.json`);
  res.json(dump);
}));

/* ------------------------- Twilio webhooks ----------------------------- */
const STOP_WORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|remove)\b/i;
app.post("/webhooks/twilio/sms", asyncHandler(async (req, res) => {
  const from = normPhone(req.body.From), to = normPhone(req.body.To), body = req.body.Body || "";
  let market = null;
  for (const m of await db.all("SELECT * FROM markets"))
    if (marketSettings(m).from_numbers.includes(to)) { market = m; break; }
  const mid = market ? market.id : ((await db.get("SELECT id FROM markets ORDER BY id LIMIT 1")) || {}).id;
  if (mid) {
    let lead = await db.get("SELECT * FROM leads WHERE market_id=? AND phone=?", mid, from);
    if (!lead) {
      const info = await db.run("INSERT INTO leads(market_id,first_name,phone,status,tags) VALUES(?,?,?,?,?)", mid, "Unknown", from, "new", "inbound");
      lead = { id: info.lastInsertRowid };
    }
    await db.run("INSERT INTO messages(market_id,lead_id,direction,channel,from_addr,to_addr,body,status) VALUES(?,?,?,?,?,?,?,?)",
      mid, lead.id, "in", "sms", from, to, body, "received");
    await db.run("UPDATE campaign_leads SET status='replied' WHERE lead_id=? AND status='active'", lead.id);
    if (STOP_WORDS.test(body)) {
      await db.run("INSERT INTO opt_outs(market_id,channel,value,reason) VALUES(?,?,?,?)", mid, "sms", from, "STOP reply");
      await db.run("UPDATE campaign_leads SET status='opted_out' WHERE lead_id=?", lead.id);
      await db.run("UPDATE leads SET status='dnc' WHERE id=?", lead.id);
    } else {
      await db.run("UPDATE leads SET status=CASE WHEN status IN('new','contacted') THEN 'responded' ELSE status END WHERE id=?", lead.id);
    }
  }
  res.type("text/xml").send("<Response></Response>");
}));
app.post("/webhooks/twilio/status", asyncHandler(async (req, res) => {
  const { MessageSid, MessageStatus } = req.body;
  if (MessageSid && ["delivered", "failed", "undelivered"].includes(MessageStatus))
    await db.run("UPDATE messages SET status=? WHERE provider_id=?", MessageStatus === "undelivered" ? "failed" : MessageStatus, MessageSid);
  res.sendStatus(200);
}));

/* email unsubscribe */
app.get("/u/:token", asyncHandler(async (req, res) => {
  try {
    const [mid, email] = Buffer.from(req.params.token, "base64url").toString().split("|");
    if (email) {
      await db.run("INSERT INTO opt_outs(market_id,channel,value,reason) VALUES(?,?,?,?)", +mid || null, "email", email.toLowerCase(), "unsubscribe link");
      await db.run("UPDATE campaign_leads SET status='opted_out' WHERE lead_id IN (SELECT id FROM leads WHERE email=?)", email.toLowerCase());
    }
    res.send("<html><body style='font-family:sans-serif;text-align:center;padding:60px'><h2>You've been unsubscribed.</h2><p>You won't receive any more emails from us.</p></body></html>");
  } catch { res.status(400).send("Invalid link"); }
}));

/* --------------------------- QUEUE ENGINE ------------------------------ */
/* Ticks every 3 s. For each running campaign: respects quiet hours (market
   timezone), market daily cap, campaign daily cap, per-minute throttle,
   number-pool round-robin, opt-outs. Multi-step drip with per-step A/B
   template variants.                                                      */
const sendTimestamps = {}; // campaignId -> [epoch ms] for throttle window
let rrIndex = {};          // marketId -> round robin pointer
let ticking = false;

function localHour(tzOffset) {
  const now = new Date(Date.now() + tzOffset * 3600 * 1000);
  return now.getUTCHours();
}
async function queueTick() {
  const campaigns = await db.all("SELECT * FROM campaigns WHERE status='running'");
  for (const c of campaigns) {
    try { await processCampaign(c); } catch (e) { console.error("campaign", c.id, e.message); }
  }
}
async function processCampaign(c) {
  const market = await db.get("SELECT * FROM markets WHERE id=?", c.market_id);
  if (!market) return;
  const ms = marketSettings(market);
  const steps = JSON.parse(c.steps_json || "[]");
  if (!steps.length) return;

  if (c.channel === "sms") {
    const h = localHour(ms.tz_offset);
    if (h < ms.quiet_start || h >= ms.quiet_end) return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const sentToday = Number((await db.get("SELECT COUNT(*) c FROM messages WHERE market_id=? AND direction='out' AND channel=? AND date(created_at)=?", c.market_id, c.channel, today)).c);
  const cap = c.channel === "sms" ? ms.daily_sms_cap : (ms.daily_email_cap || 2000);
  if (sentToday >= cap) return;
  const campSentToday = Number((await db.get("SELECT COUNT(*) c FROM messages WHERE campaign_id=? AND direction='out' AND date(created_at)=?", c.id, today)).c);
  if (campSentToday >= c.daily_cap) return;
  const now = Date.now();
  sendTimestamps[c.id] = (sendTimestamps[c.id] || []).filter(t => now - t < 60000);
  const budget = Math.min(
    Math.max(0, (c.throttle_per_min || 20) - sendTimestamps[c.id].length),
    5,
    cap - sentToday, c.daily_cap - campSentToday
  );
  if (budget <= 0) return;

  const due = await db.all("SELECT * FROM campaign_leads WHERE campaign_id=? AND status='active' AND next_send_at<=datetime('now') ORDER BY id LIMIT ?", c.id, budget);
  for (const cl of due) {
    const lead = await db.get("SELECT * FROM leads WHERE id=?", cl.lead_id);
    if (!lead) { await db.run("UPDATE campaign_leads SET status='failed' WHERE id=?", cl.id); continue; }
    const target = c.channel === "sms" ? lead.phone : lead.email;
    if (!target || await isOptedOut(c.channel, target) || lead.status === "dnc") {
      await db.run("UPDATE campaign_leads SET status='opted_out' WHERE id=?", cl.id); continue;
    }
    const step = steps[cl.step];
    if (!step) { await db.run("UPDATE campaign_leads SET status='completed' WHERE id=?", cl.id); continue; }
    const variants = step.variants && step.variants.length ? step.variants : [{ subject: step.subject, body: step.body }];
    const v = variants[Math.floor(Math.random() * variants.length)];
    const body = merge(v.body || "", lead);
    const subject = c.channel === "email" ? merge(v.subject || "", lead) : "";
    const info = await db.run("INSERT INTO messages(market_id,lead_id,campaign_id,direction,channel,to_addr,subject,body,status) VALUES(?,?,?,?,?,?,?,?,?)",
      c.market_id, lead.id, c.id, "out", c.channel, target, subject, body, "sending");
    const mid = info.lastInsertRowid;
    try {
      if (c.channel === "sms") {
        const pool = ms.from_numbers;
        if (!pool.length) throw new Error("no numbers in market pool");
        rrIndex[c.market_id] = ((rrIndex[c.market_id] || 0) + 1) % pool.length;
        const from = pool[rrIndex[c.market_id]];
        await db.run("UPDATE messages SET from_addr=? WHERE id=?", from, mid);
        const sid = await twilioSend(from, target, body);
        await db.run("UPDATE messages SET status='sent', provider_id=? WHERE id=?", sid, mid);
      } else {
        if (!ms.email_from) throw new Error("no From email set for market");
        const unsubToken = Buffer.from(`${c.market_id}|${target}`).toString("base64url");
        const base = (await getSetting("public_url")) || `http://localhost:${PORT}`;
        const unsubUrl = `${base}/u/${unsubToken}`;
        const html = body.replace(/\n/g, "<br>") + `<br><br><p style="font-size:11px;color:#888">Don't want these? <a href="${unsubUrl}">Unsubscribe</a></p>`;
        await db.run("UPDATE messages SET from_addr=? WHERE id=?", ms.email_from, mid);
        const pid = await emailSend({ fromName: ms.email_from_name, fromEmail: ms.email_from, to: target, subject, html, text: body + `\n\nUnsubscribe: ${unsubUrl}`, unsubUrl });
        await db.run("UPDATE messages SET status='sent', provider_id=? WHERE id=?", String(pid), mid);
      }
      sendTimestamps[c.id].push(Date.now());
      const nextStep = cl.step + 1;
      if (nextStep >= steps.length) {
        await db.run("UPDATE campaign_leads SET status='completed', step=? WHERE id=?", nextStep, cl.id);
      } else {
        const delayDays = Math.max(0, +steps[nextStep].delay_days || 1);
        await db.run("UPDATE campaign_leads SET step=?, next_send_at=datetime('now', ?) WHERE id=?", nextStep, `+${delayDays} days`, cl.id);
      }
      await db.run("UPDATE leads SET status=CASE WHEN status='new' THEN 'contacted' ELSE status END WHERE id=?", lead.id);
    } catch (e) {
      await db.run("UPDATE messages SET status='failed', error=? WHERE id=?", e.message, mid);
      await db.run("UPDATE campaign_leads SET status='failed' WHERE id=?", cl.id);
    }
  }
  const remaining = Number((await db.get("SELECT COUNT(*) c FROM campaign_leads WHERE campaign_id=? AND status='active'", c.id)).c);
  const total = Number((await db.get("SELECT COUNT(*) c FROM campaign_leads WHERE campaign_id=?", c.id)).c);
  if (total > 0 && remaining === 0) await db.run("UPDATE campaigns SET status='completed' WHERE id=?", c.id);
}

/* SPA fallback */
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error(err.stack || err.message || err);
  res.status(500).json({ error: err.message || "server error" });
});

async function main() {
  if (!String(process.env.DATABASE_URL || "").trim() && process.env.RENDER) {
    console.warn("DATABASE_URL is not set. Render's filesystem is ephemeral, so SQLite data will disappear on restart.");
  }
  await initDatabase(db);
  await seedMarkets();
  await seedAdmin();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Lariat Pro running on http://0.0.0.0:${PORT} (${db.driver}${db.impl ? ":" + db.impl : ""})`);
  });
  setInterval(() => {
    if (ticking) return;
    ticking = true;
    queueTick().catch(e => console.error("tick", e.message)).finally(() => { ticking = false; });
  }, 3000);
}

main().catch(err => {
  console.error("Database startup failed:", err.message);
  process.exit(1);
});
