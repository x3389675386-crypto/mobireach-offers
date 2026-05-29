const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Octokit } = require("@octokit/rest");
const nodemailer = require("nodemailer");
const multer = require("multer");
const upload = multer({ dest: path.join(__dirname, "data", "uploads") });
const XLSX = require("xlsx");

// ── Prevent unhandled rejections from crashing the process ──
process.on("unhandledRejection", (reason) => {
  console.error("🔥 Unhandled rejection:", reason);
  // Don't crash — log and keep running
});

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "mobireach2026";

// ── Email (SMTP) ──
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587");
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || "noreply@mobirich.online";

let transporter = null;
if (SMTP_HOST && SMTP_USER) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { rejectUnauthorized: false }
  });
  console.log(`📧 Email ready: ${SMTP_FROM}`);
} else {
  console.log("⚠️  Email not configured — set SMTP_HOST + SMTP_USER in env");
}

// ── GitHub data storage ──
const GH_TOKEN = process.env.GH_TOKEN;
const GH_OWNER = process.env.GH_OWNER || "x3389675386-crypto";
const GH_REPO = process.env.GH_REPO || "mobireach-data";

// Local fallback
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const LOCAL_OFFERS = path.join(DATA_DIR, "offers.json");
const LOCAL_SUBMISSIONS = path.join(DATA_DIR, "submissions.json");
const LOCAL_ACCOUNTS = path.join(DATA_DIR, "accounts.json");
const OFFERS_SEED = path.join(__dirname, "offers-seed.json");

let octokit = null;
let useGitHub = false;

async function ensureDataRepo() {
  if (!useGitHub) return;
  try {
    await octokit.repos.get({ owner: GH_OWNER, repo: GH_REPO });
    console.log(`✅ GitHub repo verified: ${GH_OWNER}/${GH_REPO}`);
  } catch (e) {
    if (e.status === 404) {
      try {
        await octokit.repos.createForAuthenticatedUser({
          name: GH_REPO,
          private: true,
          description: "Mobireach persistent data storage",
          auto_init: true,
        });
        console.log(`📦 Created data repo: ${GH_OWNER}/${GH_REPO}`);
      } catch (createErr) {
        console.warn(`❌ Cannot create data repo: ${createErr.message}. Falling back to local.`);
        useGitHub = false;
        octokit = null;
      }
    } else if (e.status === 401 || e.status === 403) {
      console.warn(`❌ GitHub auth failed (${e.status}): ${e.message}. Check GH_TOKEN. Falling back to local.`);
      useGitHub = false;
      octokit = null;
    } else {
      console.warn(`⚠️  GitHub access issue: ${e.message}`);
    }
  }

  // Ensure local fallback files exist
  if (!useGitHub) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(LOCAL_OFFERS) && fs.existsSync(OFFERS_SEED)) {
      fs.copyFileSync(OFFERS_SEED, LOCAL_OFFERS);
      console.log("📋 Seeded offers from local seed file");
    }
    if (!fs.existsSync(LOCAL_SUBMISSIONS)) {
      fs.writeFileSync(LOCAL_SUBMISSIONS, "[]", "utf-8");
    }
  }
}

let repoReady;

if (GH_TOKEN && GH_OWNER) {
  octokit = new Octokit({ auth: GH_TOKEN });
  useGitHub = true;
  console.log(`🔗 GitHub storage: ${GH_OWNER}/${GH_REPO}`);
  repoReady = ensureDataRepo();
} else {
  console.log("💾 Local storage (no GH_TOKEN set)");
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LOCAL_OFFERS) && fs.existsSync(OFFERS_SEED)) {
    fs.copyFileSync(OFFERS_SEED, LOCAL_OFFERS);
  }
  if (!fs.existsSync(LOCAL_SUBMISSIONS)) {
    fs.writeFileSync(LOCAL_SUBMISSIONS, "[]", "utf-8");
  }
  if (!fs.existsSync(LOCAL_ACCOUNTS)) {
    // Create default super admin
    const hash = crypto.createHash("sha256").update("Merlin2026!").digest("hex");
    fs.writeFileSync(LOCAL_ACCOUNTS, JSON.stringify([{
      id: 1, username: "Merlin", password: hash, role: "super_admin",
      createdAt: new Date().toISOString()
    }], null, 2), "utf-8");
  }
}

// ── In-memory caches ──
let offersCache = null;
let submissionsCache = null;

// ── Token store (in-memory) ──
const tokens = new Map(); // token → { username, role, expiresAt }

// ── GitHub API helpers ──
async function ghRead(filename) {
  try {
    const { data } = await octokit.repos.getContent({
      owner: GH_OWNER, repo: GH_REPO, path: filename,
    });
    return JSON.parse(Buffer.from(data.content, "base64").toString("utf-8"));
  } catch (e) {
    if (e.status === 404) return null;
    console.warn(`⚠️  ghRead(${filename}) failed: ${e.message} (status ${e.status || "?"})`);
    return null;
  }
}

async function ghWrite(filename, jsonData) {
  try {
    let sha;
    try {
      const { data } = await octokit.repos.getContent({
        owner: GH_OWNER, repo: GH_REPO, path: filename,
      });
      sha = data.sha;
    } catch (e) { /* first write */ }

    await octokit.repos.createOrUpdateFileContents({
      owner: GH_OWNER,
      repo: GH_REPO,
      path: filename,
      message: `Update ${filename}`,
      content: Buffer.from(JSON.stringify(jsonData, null, 2)).toString("base64"),
      sha,
    });
  } catch (e) {
    console.warn(`⚠️  ghWrite(${filename}) failed: ${e.message}. Data not persisted to GitHub.`);
  }
}

// ── Data access (GitHub first, local fallback) ──

// ── Offers ──
async function readOffers() {
  if (offersCache) return offersCache;
  if (useGitHub) {
    const data = await ghRead("offers.json");
    if (data) { offersCache = data; return data; }
    if (fs.existsSync(OFFERS_SEED)) {
      const seed = JSON.parse(fs.readFileSync(OFFERS_SEED, "utf-8"));
      await ghWrite("offers.json", seed);
      offersCache = seed;
      return seed;
    }
    return [];
  }
  try { const data = JSON.parse(fs.readFileSync(LOCAL_OFFERS, "utf-8")); offersCache = data; return data; }
  catch { return []; }
}

async function writeOffers(data) {
  offersCache = data;
  if (useGitHub) {
    await ghWrite("offers.json", data);
  } else {
    fs.writeFileSync(LOCAL_OFFERS, JSON.stringify(data, null, 2), "utf-8");
  }
}

// ── Submissions ──
async function readSubmissions() {
  if (submissionsCache) return submissionsCache;
  if (useGitHub) {
    const data = await ghRead("submissions.json");
    if (data) { submissionsCache = data; return data; }
    await ghWrite("submissions.json", []);
    submissionsCache = [];
    return [];
  }
  try { const data = JSON.parse(fs.readFileSync(LOCAL_SUBMISSIONS, "utf-8")); submissionsCache = data; return data; }
  catch { return []; }
}

async function writeSubmissions(data) {
  submissionsCache = data;
  if (useGitHub) {
    await ghWrite("submissions.json", data);
  } else {
    fs.writeFileSync(LOCAL_SUBMISSIONS, JSON.stringify(data, null, 2), "utf-8");
  }
}

// ── Accounts ──
async function readAccounts() {
  // Always read fresh — never cache, to avoid stale data after writes
  if (useGitHub) {
    const data = await ghRead("accounts.json");
    if (data) return data;
    // First run: create default super admin
    const hash = crypto.createHash("sha256").update("Merlin2026!").digest("hex");
    const def = [{ id: 1, username: "Merlin", password: hash, role: "super_admin", createdAt: new Date().toISOString() }];
    await ghWrite("accounts.json", def);
    return def;
  }
  try { return JSON.parse(fs.readFileSync(LOCAL_ACCOUNTS, "utf-8")); }
  catch { return []; }
}

async function writeAccounts(data) {
  if (useGitHub) {
    await ghWrite("accounts.json", data);
  } else {
    fs.writeFileSync(LOCAL_ACCOUNTS, JSON.stringify(data, null, 2), "utf-8");
  }
}

// ── Orders ──
const LOCAL_ORDERS = path.join(DATA_DIR, "orders.json");

async function readOrders() {
  if (useGitHub) {
    const data = await ghRead("orders.json");
    return data || [];
  }
  try { return JSON.parse(fs.readFileSync(LOCAL_ORDERS, "utf-8")); }
  catch { return []; }
}

async function writeOrders(data) {
  if (useGitHub) {
    await ghWrite("orders.json", data);
  } else {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LOCAL_ORDERS, JSON.stringify(data, null, 2), "utf-8");
  }
}

// ── Managed Orders ──
const LOCAL_MANAGED_ORDERS = path.join(DATA_DIR, "managed_orders.json");

async function readManagedOrders() {
  if (useGitHub) {
    const data = await ghRead("managed_orders.json");
    return data || [];
  }
  try { return JSON.parse(fs.readFileSync(LOCAL_MANAGED_ORDERS, "utf-8")); }
  catch { return []; }
}

async function writeManagedOrders(data) {
  if (useGitHub) {
    await ghWrite("managed_orders.json", data);
  } else {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LOCAL_MANAGED_ORDERS, JSON.stringify(data, null, 2), "utf-8");
  }
}
function hashPassword(pw) {
  return crypto.createHash("sha256").update(pw).digest("hex");
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

// Check auth: token-based first, then legacy password
async function checkAuth(req, res, requireSuper) {
  // 1. Token auth
  const token = req.headers["x-auth-token"] || req.query.token || "";
  if (token && tokens.has(token)) {
    const session = tokens.get(token);
    if (Date.now() > session.expiresAt) {
      tokens.delete(token);
      res.status(401).json({ error: "Token expired" });
      return null;
    }
    // Refresh expiry
    session.expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    if (requireSuper && session.role !== "super_admin") {
      res.status(403).json({ error: "Super admin required" });
      return null;
    }
    return session;
  }

  // 2. Legacy password auth
  const pw = req.query.password || req.headers["x-admin-password"] || "";
  if (pw === ADMIN_PASSWORD) {
    return { username: "admin", role: "legacy" };
  }

  res.status(401).json({ error: "Unauthorized" });
  return null;
}

// ── Middleware ──
app.use(express.json());

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AUTH ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Login
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  const accounts = await readAccounts();
  const account = accounts.find(a => a.username === username);
  if (!account) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const hash = hashPassword(password);
  if (hash !== account.password) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = generateToken();
  tokens.set(token, {
    username: account.username,
    role: account.role,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000
  });

  res.json({
    success: true,
    token,
    username: account.username,
    role: account.role
  });
});

// Check token validity
app.get("/api/auth/me", async (req, res) => {
  const session = await checkAuth(req, res);
  if (!session) return;
  res.json({ username: session.username, role: session.role });
});

// Logout
app.post("/api/auth/logout", (req, res) => {
  const token = req.headers["x-auth-token"] || "";
  tokens.delete(token);
  res.json({ success: true });
});

// Change own password
app.post("/api/auth/change-password", async (req, res) => {
  const session = await checkAuth(req, res);
  if (!session) return;

  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Current and new password required" });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  const accounts = await readAccounts();
  const account = accounts.find(a => a.username === session.username);
  if (!account) return res.status(404).json({ error: "Account not found" });

  const currentHash = hashPassword(currentPassword);
  if (currentHash !== account.password) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }

  account.password = hashPassword(newPassword);
  await writeAccounts(accounts);
  res.json({ success: true });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ACCOUNTS MANAGEMENT (super_admin only)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// List all accounts
app.get("/api/accounts", async (req, res) => {
  const session = await checkAuth(req, res, true);
  if (!session) return;

  const accounts = await readAccounts();
  // Return without password hashes
  const safe = accounts.map(a => ({
    id: a.id,
    username: a.username,
    role: a.role,
    createdAt: a.createdAt
  }));
  res.json(safe);
});

// Create account
app.post("/api/accounts", async (req, res) => {
  const session = await checkAuth(req, res, true);
  if (!session) return;

  const { username, password, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  if (!["admin", "super_admin"].includes(role)) {
    return res.status(400).json({ error: "Role must be admin or super_admin" });
  }

  const accounts = await readAccounts();
  if (accounts.find(a => a.username === username)) {
    return res.status(409).json({ error: "Username already exists" });
  }

  const maxId = accounts.reduce((max, a) => Math.max(max, a.id), 0);
  const newAccount = {
    id: maxId + 1,
    username,
    password: hashPassword(password),
    role,
    createdAt: new Date().toISOString()
  };
  accounts.push(newAccount);
  await writeAccounts(accounts);

  res.status(201).json({
    success: true,
    account: { id: newAccount.id, username: newAccount.username, role: newAccount.role, createdAt: newAccount.createdAt }
  });
});

// Update account (change role)
app.put("/api/accounts/:id", async (req, res) => {
  const session = await checkAuth(req, res, true);
  if (!session) return;

  const { role } = req.body;
  if (!["admin", "super_admin"].includes(role)) {
    return res.status(400).json({ error: "Role must be admin or super_admin" });
  }

  const accounts = await readAccounts();
  const account = accounts.find(a => a.id === parseInt(req.params.id));
  if (!account) return res.status(404).json({ error: "Account not found" });

  // Cannot demote self
  if (account.username === session.username && role !== "super_admin") {
    return res.status(400).json({ error: "Cannot demote yourself" });
  }

  account.role = role;
  await writeAccounts(accounts);
  res.json({ success: true, account: { id: account.id, username: account.username, role: account.role } });
});

// Reset account password (super_admin only)
app.post("/api/accounts/:id/reset-password", async (req, res) => {
  const session = await checkAuth(req, res, true);
  if (!session) return;

  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters" });
  }

  const accounts = await readAccounts();
  const account = accounts.find(a => a.id === parseInt(req.params.id));
  if (!account) return res.status(404).json({ error: "Account not found" });

  account.password = hashPassword(newPassword);
  await writeAccounts(accounts);
  res.json({ success: true });
});

// Delete account
app.delete("/api/accounts/:id", async (req, res) => {
  const session = await checkAuth(req, res, true);
  if (!session) return;

  const accounts = await readAccounts();
  const account = accounts.find(a => a.id === parseInt(req.params.id));
  if (!account) return res.status(404).json({ error: "Account not found" });

  if (account.username === session.username) {
    return res.status(400).json({ error: "Cannot delete your own account" });
  }

  // Don't delete the last super_admin
  if (account.role === "super_admin") {
    const superCount = accounts.filter(a => a.role === "super_admin").length;
    if (superCount <= 1) {
      return res.status(400).json({ error: "Cannot delete the last super admin" });
    }
  }

  const filtered = accounts.filter(a => a.id !== parseInt(req.params.id));
  await writeAccounts(filtered);
  res.json({ success: true });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PUBLIC API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Submit Application
app.post("/api/apply", async (req, res) => {
  const { publisher, pids, emails, handshake, comment, offerName, offerPlatform } = req.body;

  if (!publisher || !pids || !pids.length || !emails || !emails.length || !handshake) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const submission = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    offerName: offerName || "—",
    offerPlatform: offerPlatform || "—",
    publisher,
    pids,
    emails,
    handshake: true,
    comment: comment || "",
    status: "new"
  };

  const submissions = await readSubmissions();
  submissions.unshift(submission);
  await writeSubmissions(submissions);

  console.log(`✅ New application: ${publisher} → ${offerName} (${offerPlatform})`);
  res.json({ success: true, id: submission.id });
});

// Get All Offers (public)
app.get("/api/offers", async (req, res) => {
  res.json(await readOffers());
});

// Get Single Offer (public)
app.get("/api/offers/:id", async (req, res) => {
  const offers = await readOffers();
  const offer = offers.find(o => o.id === parseInt(req.params.id));
  if (!offer) return res.status(404).json({ error: "Not found" });
  res.json(offer);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ADMIN API (require auth)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// List Submissions
app.get("/api/submissions", async (req, res) => {
  if (!(await checkAuth(req, res))) return;
  res.json(await readSubmissions());
});

// Update Submission Status
app.patch("/api/submissions/:id/status", async (req, res) => {
  if (!(await checkAuth(req, res))) return;
  const { status } = req.body;
  if (!["new", "viewed", "contacted"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  const submissions = await readSubmissions();
  const idx = submissions.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  submissions[idx].status = status;
  await writeSubmissions(submissions);
  res.json({ success: true });
});

// Delete Submission
app.delete("/api/submissions/:id", async (req, res) => {
  if (!(await checkAuth(req, res))) return;
  let submissions = await readSubmissions();
  submissions = submissions.filter(s => s.id !== req.params.id);
  await writeSubmissions(submissions);
  res.json({ success: true });
});

// Update Offer
app.put("/api/offers/:id", async (req, res) => {
  if (!(await checkAuth(req, res))) return;
  const offers = await readOffers();
  const idx = offers.findIndex(o => o.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: "Not found" });

  const allowedFields = ["name", "platform", "payout", "currency", "geos", "icon", "iconLetter", "details"];
  allowedFields.forEach(field => {
    if (req.body[field] !== undefined) {
      offers[idx][field] = req.body[field];
    }
  });

  await writeOffers(offers);
  res.json({ success: true, offer: offers[idx] });
});

// Create Offer
app.post("/api/offers", async (req, res) => {
  if (!(await checkAuth(req, res))) return;
  const offers = await readOffers();
  const maxId = offers.reduce((max, o) => Math.max(max, o.id), 0);
  const newOffer = {
    id: maxId + 1,
    name: req.body.name || "New Offer",
    platform: req.body.platform || "ios",
    payout: req.body.payout || 0,
    currency: req.body.currency || "USD",
    geos: req.body.geos || [],
    icon: req.body.icon || null,
    iconLetter: req.body.iconLetter || "N",
    details: req.body.details || {
      geo: "", payout: "", storeUrl: "", payableEvent: "",
      flow: "—", kpi: "—", prt: "—", integrations: []
    }
  };
  offers.push(newOffer);
  await writeOffers(offers);
  res.status(201).json({ success: true, offer: newOffer });
});

// Delete Offer
app.delete("/api/offers/:id", async (req, res) => {
  if (!(await checkAuth(req, res))) return;
  let offers = await readOffers();
  const before = offers.length;
  offers = offers.filter(o => o.id !== parseInt(req.params.id));
  if (offers.length === before) return res.status(404).json({ error: "Not found" });
  await writeOffers(offers);
  res.json({ success: true });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ORDER EMAIL API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Get all orders
app.get("/api/orders", async (req, res) => {
  if (!(await checkAuth(req, res))) return;
  res.json(await readOrders());
});

// Save order (no email — mailto handled by frontend)
app.post("/api/orders", async (req, res) => {
  const session = await checkAuth(req, res);
  if (!session) return;

  const {
    submissionId, publisher, offerName, offerPlatform,
    platform, customerId, channel, campaignName,
    prt, pid, externalPrice, realPrice,
    trackingLink, emailSubject, emailBody, recipients
  } = req.body;

  const order = {
    id: crypto.randomUUID(),
    submissionId: submissionId || "",
    publisher: publisher || "",
    offerName: offerName || "",
    offerPlatform: offerPlatform || "",
    platform: platform || "",
    customerId: customerId || "",
    channel: channel || "",
    campaignName: campaignName || "",
    prt: prt || "",
    pid: pid || "",
    externalPrice: externalPrice || 0,
    realPrice: realPrice || 0,
    trackingLink: trackingLink || "",
    emailSubject: emailSubject || `Campaign Order: ${campaignName || "New Order"}`,
    emailBody: emailBody || "",
    recipients: recipients || [],
    createdAt: new Date().toISOString(),
    sentBy: session.username,
    status: "saved"
  };

  const orders = await readOrders();
  orders.unshift(order);
  await writeOrders(orders);

  // Auto-update submission status to "contacted"
  if (order.submissionId) {
    try {
      const subs = await readSubmissions();
      const sub = subs.find(s => s.id === order.submissionId);
      if (sub && sub.status !== "contacted") {
        sub.status = "contacted";
        await writeSubmissions(subs);
      }
    } catch (e) { /* non-critical */ }
  }

  res.json({ success: true, order });
});

// Send order email (SMTP)
app.post("/api/orders/send", async (req, res) => {
  const session = await checkAuth(req, res);
  if (!session) return;

  const {
    submissionId, publisher, offerName, offerPlatform,
    platform, customerId, channel, campaignName,
    prt, pid, externalPrice, realPrice,
    trackingLink, emailSubject, emailBody, recipients
  } = req.body;

  if (!recipients || !recipients.length) {
    return res.status(400).json({ error: "At least one recipient required" });
  }

  const order = {
    id: crypto.randomUUID(),
    submissionId: submissionId || "",
    publisher: publisher || "",
    offerName: offerName || "",
    offerPlatform: offerPlatform || "",
    platform: platform || "",
    customerId: customerId || "",
    channel: channel || "",
    campaignName: campaignName || "",
    prt: prt || "",
    pid: pid || "",
    externalPrice: externalPrice || 0,
    realPrice: realPrice || 0,
    trackingLink: trackingLink || "",
    emailSubject: emailSubject || `Campaign Order: ${campaignName || "New Order"}`,
    emailBody: emailBody || "",
    recipients,
    createdAt: new Date().toISOString(),
    sentBy: session.username,
    status: "sending"
  };

  // Persist order
  const orders = await readOrders();
  orders.unshift(order);
  await writeOrders(orders);

  if (!transporter) {
    order.status = "saved_no_email";
    orders[0].status = order.status;
    await writeOrders(orders);
    return res.json({
      success: true,
      order,
      warning: "Email not sent: SMTP not configured. Set SMTP_HOST and SMTP_USER in Render env vars."
    });
  }

  // Send emails to each recipient
  let sentCount = 0;
  let errors = [];
  for (const recipient of recipients) {
    try {
      await transporter.sendMail({
        from: `"Mobireach" <${SMTP_FROM}>`,
        to: recipient,
        subject: emailSubject || `Campaign Order: ${campaignName || "New Order"}`,
        text: emailBody,
      });
      sentCount++;
    } catch (e) {
      errors.push(`${recipient}: ${e.message}`);
      console.warn(`⚠️  Email to ${recipient} failed: ${e.message}`);
    }
  }

  if (sentCount === recipients.length) {
    order.status = "sent";
    console.log(`✅ Order email sent to all ${sentCount} recipients`);
  } else if (sentCount > 0) {
    order.status = "partial";
    order.emailErrors = errors;
    console.log(`⚠️  Sent ${sentCount}/${recipients.length} emails`);
  } else {
    order.status = "email_failed";
    order.emailErrors = errors;
    console.log(`❌ All emails failed`);
  }

  orders[0].status = order.status;
  orders[0].sentCount = sentCount;
  if (errors.length) orders[0].emailErrors = errors;
  await writeOrders(orders);

  // Auto-update submission status to "contacted"
  if (order.submissionId) {
    try {
      const subs = await readSubmissions();
      const sub = subs.find(s => s.id === order.submissionId);
      if (sub && sub.status !== "contacted") {
        sub.status = "contacted";
        await writeSubmissions(subs);
      }
    } catch (e) { /* non-critical */ }
  }

  res.json({ success: true, order });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MANAGED ORDERS API (order history management)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Import managed orders from Excel
app.post("/api/managed-orders/import", upload.single("file"), async (req, res) => {
  const session = await checkAuth(req, res);
  if (!session) return;

  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const filePath = req.file.path;
  let parsed;
  try {
    const wb = XLSX.readFile(filePath, { type: "file", codepage: 65001 });
    const wsname = wb.SheetNames[0];
    const ws = wb.Sheets[wsname];
    parsed = XLSX.utils.sheet_to_json(ws, { defval: null, raw: false });
  } catch (e) {
    try { fs.unlinkSync(filePath); } catch (_) {}
    return res.status(400).json({ error: "Failed to parse Excel: " + e.message });
  }

  // Try to clean up temp file
  try { fs.unlinkSync(filePath); } catch (_) {}

  if (!parsed.length) return res.status(400).json({ error: "Empty Excel file" });

  // Map columns to managed order fields
  const existing = await readManagedOrders();
  let added = 0, skipped = 0;

  for (const row of parsed) {
    // Get field by column position or header name (support multiple naming variants)
    const cols = Object.keys(row);
    const getVal = (idx, ...names) => {
      // Try by header name first
      for (const n of names) { if (n && row[n] != null && row[n] !== "") return row[n]; }
      // Fallback to column index
      if (idx < cols.length) return row[cols[idx]];
      return "";
    };
    const cid = String(getVal(0, "客户编号", "客戶編號") || "");
    const cn = String(getVal(3, "Campaign Name") || "");
    const pr = String(getVal(4, "PRT") || "");
    const pi = String(getVal(5, "PID") || "");
    if (!cid && !cn && !pr && !pi) { skipped++; continue; }

    // Dedup: same customer_id + campaign_name + prt + pid
    const dup = existing.find(mo =>
      String(mo.customer_id) === cid &&
      String(mo.campaign_name || "") === cn &&
      String(mo.prt || "") === pr &&
      String(mo.pid || "") === pi
    );
    if (dup) { skipped++; continue; }

    existing.push({
      id: crypto.randomUUID(),
      customer_id: cid,
      channel: String(getVal(1, "下单渠道", "下單渠道") || ""),
      platform: String(getVal(2, "平台") || ""),
      campaign_name: cn,
      prt: pr,
      pid: pi,
      conversions: getVal(6, "转化", "轉化") || null,
      revenue: getVal(7, "流水") || null,
      gross_profit: getVal(8, "毛利") || null,
      payout: String(getVal(9, "Payout") || ""),
      real_po_price: String(getVal(10, "真实PO价格", "真實PO價格") || ""),
      link: getVal(11, "链接", "鏈接") || null,
      adgroup_name: getVal(12, "Adgroup Name") || null,
      imported_at: getVal(13, "创建时间", "創建時間") || getVal(14, "更新时间", "更新時間") || new Date().toISOString(),
      owner: session.username,
      status: "运行中",
      notes: "",
      created_at: new Date().toISOString()
    });
    added++;
  }

  await writeManagedOrders(existing);
  res.json({ success: true, added, skipped, total: existing.length });
});

// List managed orders (owner-filtered)
app.get("/api/managed-orders", async (req, res) => {
  const session = await checkAuth(req, res);
  if (!session) return;

  let orders = await readManagedOrders();
  orders = orders.filter(o => o.owner === session.username);

  if (req.query.customer_id) {
    const cid = String(req.query.customer_id).toLowerCase();
    orders = orders.filter(o => String(o.customer_id).toLowerCase().includes(cid));
  }
  if (req.query.channel) {
    const ch = req.query.channel.toLowerCase();
    orders = orders.filter(o => (o.channel || "").toLowerCase().includes(ch));
  }
  if (req.query.search) {
    const q = req.query.search.toLowerCase();
    orders = orders.filter(o =>
      String(o.customer_id).includes(q) ||
      (o.channel || "").toLowerCase().includes(q) ||
      (o.campaign_name || "").toLowerCase().includes(q) ||
      (o.prt || "").toLowerCase().includes(q) ||
      (o.pid || "").toLowerCase().includes(q) ||
      (o.notes || "").toLowerCase().includes(q)
    );
  }

  // Sort by customer_id
  orders.sort((a, b) => {
    const ai = parseInt(a.customer_id) || 0;
    const bi = parseInt(b.customer_id) || 0;
    return ai - bi;
  });

  res.json(orders);
});

// Update single managed order (status / notes)
app.patch("/api/managed-orders/:id", async (req, res) => {
  const session = await checkAuth(req, res);
  if (!session) return;

  const orders = await readManagedOrders();
  const idx = orders.findIndex(o => o.id === req.params.id && o.owner === session.username);
  if (idx === -1) return res.status(404).json({ error: "Not found" });

  if (req.body.status !== undefined) {
    if (!["运行中", "暂停中", "已完成", "已取消"].includes(req.body.status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    orders[idx].status = req.body.status;
  }
  if (req.body.notes !== undefined) {
    orders[idx].notes = req.body.notes;
  }

  await writeManagedOrders(orders);
  res.json({ success: true, order: orders[idx] });
});

// Delete managed order
app.delete("/api/managed-orders/:id", async (req, res) => {
  const session = await checkAuth(req, res);
  if (!session) return;

  let orders = await readManagedOrders();
  const before = orders.length;
  orders = orders.filter(o => !(o.id === req.params.id && o.owner === session.username));
  if (orders.length === before) return res.status(404).json({ error: "Not found" });

  await writeManagedOrders(orders);
  res.json({ success: true });
});

// Export managed orders to Excel
app.get("/api/managed-orders/export", async (req, res) => {
  const session = await checkAuth(req, res);
  if (!session) return;

  let orders = await readManagedOrders();
  orders = orders.filter(o => o.owner === session.username);

  const headers = ["状态", "备注", "客户编号", "下单渠道", "平台", "Campaign Name", "PRT", "PID", "Payout", "真实PO价格", "Adgroup Name", "链接", "转化", "流水", "毛利", "创建时间"];
  const rows = [headers];
  for (const o of orders) {
    rows.push([
      o.status || "", o.notes || "",
      o.customer_id, o.channel || "",
      o.platform || "", o.campaign_name || "",
      o.prt || "", o.pid || "",
      o.payout || "", o.real_po_price || "",
      o.adgroup_name || "", o.link || "",
      o.conversions || "", o.revenue || "",
      o.gross_profit || "", o.imported_at || ""
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "订单管理");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="orders_${new Date().toISOString().slice(0,10)}.xlsx"`);
  res.send(buf);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PUB BILL CATEGORIZATION (PUB账单分类)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// In-memory store for split results (keyed by session token hash)
const pubSplitCache = new Map();

// Split PUB bill Excel by customer ID
app.post("/api/pub-bills/split", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  let wb, sheets;
  try {
    wb = XLSX.readFile(req.file.path, { type: "file", codepage: 65001 });
    sheets = wb.SheetNames;
    if (!sheets.length) throw new Error("Empty workbook");
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(400).json({ error: "无法解析 Excel 文件: " + e.message });
  }

  // Identify the "客户编号" column and collect all rows
  const colName = req.body.column || "客户编号";
  const allRows = [];
  const sheetMeta = [];

  for (const sname of sheets) {
    const ws = wb.Sheets[sname];
    const data = XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
    if (!data.length) continue;

    const headers = Object.keys(data[0]);

    // Find the customer ID column
    let cidKey = null;
    for (const h of headers) {
      if (h && h.includes(colName)) { cidKey = h; break; }
    }
    if (!cidKey) {
      // Try positional fallback: first column
      cidKey = headers[0];
    }

    // Label each row with source sheet
    for (const row of data) {
      row._sheet = sname;
      row._cid_key = cidKey;
      allRows.push(row);
    }
    sheetMeta.push({ name: sname, rows: data.length, headers });
  }

  // Group by customer ID
  const groups = {};
  for (const row of allRows) {
    const cid = String(row[row._cid_key] || "未分类").trim();
    if (!groups[cid]) groups[cid] = [];
    groups[cid].push(row);
  }

  // Build output workbook: one sheet per customer
  const outWb = XLSX.utils.book_new();
  const customerList = Object.keys(groups).sort((a, b) => {
    const ai = parseInt(a) || 0;
    const bi = parseInt(b) || 0;
    return ai - bi;
  });

  for (const cid of customerList) {
    const rows = groups[cid];
    // Collect all unique headers across rows (in order of first occurrence)
    const seenHeaders = new Set();
    const orderedHeaders = [];
    for (const row of rows) {
      for (const k of Object.keys(row)) {
        if (!seenHeaders.has(k) && !k.startsWith("_")) {
          seenHeaders.add(k);
          orderedHeaders.push(k);
        }
      }
    }

    const aoa = [orderedHeaders];
    for (const row of rows) {
      const r = orderedHeaders.map(h => row[h] !== undefined ? row[h] : "");
      aoa.push(r);
    }

    // Sheet name limited to 31 chars (Excel limit)
    const sheetName = `客户${cid}`.slice(0, 31);
    const outWs = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(outWb, outWs, sheetName);
  }

  // Write to temp file
  const resultId = crypto.randomUUID();
  const outPath = path.join(DATA_DIR, "uploads", `pub-split-${resultId}.xlsx`);
  if (!fs.existsSync(path.join(DATA_DIR, "uploads"))) {
    fs.mkdirSync(path.join(DATA_DIR, "uploads"), { recursive: true });
  }
  XLSX.writeFile(outWb, outPath);

  // Clean up
  try { fs.unlinkSync(req.file.path); } catch (_) {}

  // Cache result info
  pubSplitCache.set(resultId, {
    path: outPath,
    customers: customerList.length,
    totalRows: allRows.length,
    sheets: sheetMeta,
    createdAt: Date.now()
  });

  res.json({
    success: true,
    resultId,
    customerCount: customerList.length,
    totalRows: allRows.length,
    customers: customerList,
    sheets: sheetMeta
  });
});

// Download split result
app.get("/api/pub-bills/download/:id", (req, res) => {
  const info = pubSplitCache.get(req.params.id);
  if (!info) return res.status(404).json({ error: "结果已过期，请重新上传" });

  try {
    const buf = fs.readFileSync(info.path);
    const filename = `PUB_${info.customers}customers_${new Date().toISOString().slice(0,10)}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: "文件读取失败" });
  } finally {
    try { fs.unlinkSync(info.path); } catch (_) {}
    pubSplitCache.delete(req.params.id);
  }
});

// ── Admin Page ──
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

// ── Static files (after API routes) ──
app.use(express.static(__dirname));

// ── Start ──
app.listen(PORT, async () => {
  try {
    if (repoReady) await repoReady;
  } catch (e) {
    console.warn(`❌ GitHub init crashed: ${e.message}. Switching to local storage.`);
    useGitHub = false;
    octokit = null;
  }

  // Final safety net: ensure local files exist
  if (!useGitHub) {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      if (!fs.existsSync(LOCAL_OFFERS) && fs.existsSync(OFFERS_SEED)) {
        fs.copyFileSync(OFFERS_SEED, LOCAL_OFFERS);
      }
      if (!fs.existsSync(LOCAL_SUBMISSIONS)) {
        fs.writeFileSync(LOCAL_SUBMISSIONS, "[]", "utf-8");
      }
    } catch (e) {
      console.warn("Failed to initialize local files:", e.message);
    }
  }

  try {
    const accts = await readAccounts();
    console.log(`👤 Accounts initialized (${accts.length} users)`);
  } catch (e) {
    console.warn("Failed to load accounts:", e.message);
  }

  console.log(`
  ╔══════════════════════════════════════╗
  ║   Mobireach Server is running!       ║
  ║                                      ║
  ║   🌐  Site:  http://localhost:${PORT}   ║
  ║   📊  Admin: http://localhost:${PORT}/admin ║
  ║   👤  Super Admin: Merlin           ║
  ║   💾  Storage: ${useGitHub ? `GitHub (${GH_OWNER}/${GH_REPO})` : "Local"}  ║
  ╚══════════════════════════════════════╝
  `);
});
