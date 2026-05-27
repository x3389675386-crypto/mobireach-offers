const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Octokit } = require("@octokit/rest");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "mobireach2026";

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
  } catch (e) {
    if (e.status === 404) {
      await octokit.repos.createForAuthenticatedUser({
        name: GH_REPO,
        private: true,
        description: "Mobireach persistent data storage",
        auto_init: true,
      });
      console.log(`📦 Created data repo: ${GH_OWNER}/${GH_REPO}`);
    } else {
      console.warn(`⚠️  Cannot access data repo: ${e.message}`);
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
let accountsCache = null;

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
    throw e;
  }
}

async function ghWrite(filename, jsonData) {
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
  try { return JSON.parse(fs.readFileSync(LOCAL_OFFERS, "utf-8")); }
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
  try { return JSON.parse(fs.readFileSync(LOCAL_SUBMISSIONS, "utf-8")); }
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
  if (accountsCache) return accountsCache;
  if (useGitHub) {
    const data = await ghRead("accounts.json");
    if (data) { accountsCache = data; return data; }
    // First run: create default super admin
    const hash = crypto.createHash("sha256").update("Merlin2026!").digest("hex");
    const def = [{ id: 1, username: "Merlin", password: hash, role: "super_admin", createdAt: new Date().toISOString() }];
    await ghWrite("accounts.json", def);
    accountsCache = def;
    return def;
  }
  try { return JSON.parse(fs.readFileSync(LOCAL_ACCOUNTS, "utf-8")); }
  catch { return []; }
}

async function writeAccounts(data) {
  accountsCache = data;
  if (useGitHub) {
    await ghWrite("accounts.json", data);
  } else {
    fs.writeFileSync(LOCAL_ACCOUNTS, JSON.stringify(data, null, 2), "utf-8");
  }
}

// ── Auth helpers ──
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

// ── Admin Page ──
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

// ── Static files (after API routes) ──
app.use(express.static(__dirname));

// ── Start ──
app.listen(PORT, async () => {
  if (repoReady) await repoReady;
  // Ensure accounts exist
  await readAccounts();
  console.log(`
  ╔══════════════════════════════════════╗
  ║   Mobireach Server is running!       ║
  ║                                      ║
  ║   🌐  Site:  http://localhost:${PORT}   ║
  ║   📊  Admin: http://localhost:${PORT}/admin ║
  ║   👤  Super Admin: Merlin           ║
  ╚══════════════════════════════════════╝
  `);
});
