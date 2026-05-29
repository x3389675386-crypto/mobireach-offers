const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { Octokit } = require("@octokit/rest");
const nodemailer = require("nodemailer");
const multer = require("multer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const compression = require("compression");
const upload = multer({
  dest: path.join(__dirname, "data", "uploads"),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit (#9)
});
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
const LOCAL_TOKENS = path.join(DATA_DIR, "tokens.json"); // #2 Token persistence
const LOCAL_AUDIT = path.join(DATA_DIR, "audit.json"); // #12 Audit log
const LOCAL_EMAIL_TEMPLATES = path.join(DATA_DIR, "email_templates.json"); // #16 Email templates
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
    // Create default super admin with bcrypt hash (#1)
    (async () => {
      const hash = await bcrypt.hash("Merlin2026!", 10);
      fs.writeFileSync(LOCAL_ACCOUNTS, JSON.stringify([{
        id: 1, username: "Merlin", password: hash, role: "super_admin",
        createdAt: new Date().toISOString()
      }], null, 2), "utf-8");
    })();
  }
  // #12: Initialize audit.json
  if (!fs.existsSync(LOCAL_AUDIT)) {
    fs.writeFileSync(LOCAL_AUDIT, "[]", "utf-8");
  }
  // #16: Initialize email_templates.json with default template
  if (!fs.existsSync(LOCAL_EMAIL_TEMPLATES)) {
    const defaultTemplates = {
      default: {
        name: "默认模板",
        subject: "MobiReach - {offerName} Offer Details",
        body: "Hi {publisher},\n\nHere are the details for {offerName}...\n\nPayout: {payout}\nGEO: {geo}\n\nBest regards,\nMobiReach Team"
      }
    };
    fs.writeFileSync(LOCAL_EMAIL_TEMPLATES, JSON.stringify(defaultTemplates, null, 2), "utf-8");
  }
}

// ── In-memory caches ──
let offersCache = null;
let offersCacheTime = 0; // #10 offersCache TTL timestamp
let submissionsCache = null;
let submissionsCacheTime = 0; // submissionsCache TTL timestamp

// ── Token store (in-memory + file persistence) (#2) ──
const tokens = new Map(); // token → { username, role, expiresAt }

// Load tokens from file on startup (only in local mode)
if (!useGitHub && fs.existsSync(LOCAL_TOKENS)) {
  try {
    const savedTokens = JSON.parse(fs.readFileSync(LOCAL_TOKENS, "utf-8"));
    if (Array.isArray(savedTokens)) {
      for (const [t, session] of savedTokens) {
        // Skip expired tokens
        if (session.expiresAt && Date.now() < session.expiresAt) {
          tokens.set(t, session);
        }
      }
    }
    console.log(`🔑 Restored ${tokens.size} active tokens from file`);
  } catch (e) {
    console.warn("⚠️  Failed to load tokens from file:", e.message);
  }
}

/** Persist tokens to file (only in local mode) */
function persistTokens() {
  if (useGitHub) return;
  try {
    const entries = Array.from(tokens.entries());
    fs.writeFileSync(LOCAL_TOKENS, JSON.stringify(entries, null, 2), "utf-8");
  } catch (e) {
    console.error("❌ Failed to persist tokens:", e.message);
  }
}

// ── Concurrent write lock (#7) ──
const writeLocks = {};
async function withWriteLock(key, fn) {
  while (writeLocks[key]) await writeLocks[key];
  let resolve;
  writeLocks[key] = new Promise(r => resolve = r);
  try { return await fn(); }
  finally { delete writeLocks[key]; resolve(); }
}

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
  // #10: Check cache TTL (5 minutes)
  if (offersCache && offersCacheTime && (Date.now() - offersCacheTime < 5 * 60 * 1000)) {
    return offersCache;
  }
  // Cache expired or not set — clear and re-read
  offersCache = null;
  if (useGitHub) {
    const data = await ghRead("offers.json");
    if (data) { offersCache = data; offersCacheTime = Date.now(); return data; }
    if (fs.existsSync(OFFERS_SEED)) {
      const seed = JSON.parse(fs.readFileSync(OFFERS_SEED, "utf-8"));
      await ghWrite("offers.json", seed);
      offersCache = seed;
      offersCacheTime = Date.now();
      return seed;
    }
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(LOCAL_OFFERS, "utf-8"));
    offersCache = data;
    offersCacheTime = Date.now();
    return data;
  } catch (e) {
    console.error("❌ readOffers failed:", e.message); // #11
    return [];
  }
}

async function writeOffers(data) {
  offersCache = data;
  offersCacheTime = Date.now(); // #10: update cache timestamp
  submissionsCache = null; // #10: invalidate submissionsCache for consistency
  await withWriteLock("offers", async () => { // #7: write lock
    if (useGitHub) {
      await ghWrite("offers.json", data);
    } else {
      fs.writeFileSync(LOCAL_OFFERS, JSON.stringify(data, null, 2), "utf-8");
    }
  });
}

// ── Submissions ──
async function readSubmissions() {
  // TTL check: 5 minutes
  if (submissionsCache && submissionsCacheTime && (Date.now() - submissionsCacheTime < 5 * 60 * 1000)) {
    return submissionsCache;
  }
  submissionsCache = null;
  if (useGitHub) {
    const data = await ghRead("submissions.json");
    if (data) { submissionsCache = data; submissionsCacheTime = Date.now(); return data; }
    await ghWrite("submissions.json", []);
    submissionsCache = [];
    submissionsCacheTime = Date.now();
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(LOCAL_SUBMISSIONS, "utf-8"));
    submissionsCache = data;
    submissionsCacheTime = Date.now();
    return data;
  } catch (e) {
    console.error("❌ readSubmissions failed:", e.message); // #11
    return [];
  }
}

async function writeSubmissions(data) {
  submissionsCache = data;
  submissionsCacheTime = Date.now(); // update cache timestamp
  await withWriteLock("submissions", async () => { // #7
    if (useGitHub) {
      await ghWrite("submissions.json", data);
    } else {
      fs.writeFileSync(LOCAL_SUBMISSIONS, JSON.stringify(data, null, 2), "utf-8");
    }
  });
}

// ── Accounts ──
async function readAccounts() {
  // Always read fresh — never cache, to avoid stale data after writes
  if (useGitHub) {
    const data = await ghRead("accounts.json");
    if (data) return data;
    // First run: create default super admin with bcrypt (#1)
    const hash = await bcrypt.hash("Merlin2026!", 10);
    const def = [{ id: 1, username: "Merlin", password: hash, role: "super_admin", createdAt: new Date().toISOString() }];
    await ghWrite("accounts.json", def);
    return def;
  }
  try { return JSON.parse(fs.readFileSync(LOCAL_ACCOUNTS, "utf-8")); }
  catch (e) {
    console.error("❌ readAccounts failed:", e.message); // #11
    return [];
  }
}

async function writeAccounts(data) {
  await withWriteLock("accounts", async () => { // #7
    if (useGitHub) {
      await ghWrite("accounts.json", data);
    } else {
      fs.writeFileSync(LOCAL_ACCOUNTS, JSON.stringify(data, null, 2), "utf-8");
    }
  });
}

// ── Orders ──
const LOCAL_ORDERS = path.join(DATA_DIR, "orders.json");

async function readOrders() {
  if (useGitHub) {
    const data = await ghRead("orders.json");
    return data || [];
  }
  try { return JSON.parse(fs.readFileSync(LOCAL_ORDERS, "utf-8")); }
  catch (e) {
    console.error("❌ readOrders failed:", e.message); // #11
    return [];
  }
}

async function writeOrders(data) {
  await withWriteLock("orders", async () => { // #7
    if (useGitHub) {
      await ghWrite("orders.json", data);
    } else {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(LOCAL_ORDERS, JSON.stringify(data, null, 2), "utf-8");
    }
  });
}

// ── Managed Orders ──
const LOCAL_MANAGED_ORDERS = path.join(DATA_DIR, "managed_orders.json");

async function readManagedOrders() {
  if (useGitHub) {
    const data = await ghRead("managed_orders.json");
    return data || [];
  }
  try { return JSON.parse(fs.readFileSync(LOCAL_MANAGED_ORDERS, "utf-8")); }
  catch (e) {
    console.error("❌ readManagedOrders failed:", e.message); // #11
    return [];
  }
}

async function writeManagedOrders(data) {
  await withWriteLock("managed_orders", async () => { // #7
    if (useGitHub) {
      await ghWrite("managed_orders.json", data);
    } else {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(LOCAL_MANAGED_ORDERS, JSON.stringify(data, null, 2), "utf-8");
    }
  });
}

// ── Audit Log (#12) ──
async function readAuditLog() {
  if (useGitHub) {
    const data = await ghRead("audit.json");
    return data || [];
  }
  try { return JSON.parse(fs.readFileSync(LOCAL_AUDIT, "utf-8")); }
  catch (e) { return []; }
}

async function writeAuditLogData(data) {
  await withWriteLock("audit", async () => {
    if (useGitHub) {
      await ghWrite("audit.json", data);
    } else {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(LOCAL_AUDIT, JSON.stringify(data, null, 2), "utf-8");
    }
  });
}

/**
 * Write an audit log entry. Wrapped in try-catch so audit failure never blocks business.
 * @param {string} action - create/update/delete/batch_delete/batch_update/export/import/login
 * @param {string} target - offers/submissions/orders/accounts/email_templates
 * @param {string} targetId - ID of the affected resource
 * @param {object|string} detail - Details about the change
 * @param {object} req - Express request object (for user info)
 */
async function writeAudit(action, target, targetId, detail, req) {
  try {
    const audit = await readAuditLog();
    let user = "system";
    if (req && req.headers && req.headers["x-auth-token"]) {
      const session = tokens.get(req.headers["x-auth-token"]);
      if (session) user = session.username;
    } else if (req && req.body && req.body.username) {
      user = req.body.username;
    }
    audit.push({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      user,
      action,
      target,
      targetId: String(targetId || ""),
      detail: typeof detail === "string" ? detail : JSON.stringify(detail || {})
    });
    // Keep last 10000 entries to prevent unbounded growth
    if (audit.length > 10000) audit.splice(0, audit.length - 10000);
    await writeAuditLogData(audit);
  } catch (e) {
    console.error("❌ Audit write failed:", e.message);
    // Audit failure must not block business operations
  }
}

// ── Email Templates (#16) ──
async function readEmailTemplates() {
  if (useGitHub) {
    const data = await ghRead("email_templates.json");
    if (data) return data;
    const def = {
      default: {
        name: "默认模板",
        subject: "MobiReach - {offerName} Offer Details",
        body: "Hi {publisher},\n\nHere are the details for {offerName}...\n\nPayout: {payout}\nGEO: {geo}\n\nBest regards,\nMobiReach Team"
      }
    };
    await ghWrite("email_templates.json", def);
    return def;
  }
  try { return JSON.parse(fs.readFileSync(LOCAL_EMAIL_TEMPLATES, "utf-8")); }
  catch (e) {
    const def = {
      default: {
        name: "默认模板",
        subject: "MobiReach - {offerName} Offer Details",
        body: "Hi {publisher},\n\nHere are the details for {offerName}...\n\nPayout: {payout}\nGEO: {geo}\n\nBest regards,\nMobiReach Team"
      }
    };
    fs.writeFileSync(LOCAL_EMAIL_TEMPLATES, JSON.stringify(def, null, 2), "utf-8");
    return def;
  }
}

async function writeEmailTemplatesData(data) {
  await withWriteLock("email_templates", async () => {
    if (useGitHub) {
      await ghWrite("email_templates.json", data);
    } else {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(LOCAL_EMAIL_TEMPLATES, JSON.stringify(data, null, 2), "utf-8");
    }
  });
}

// ── Password hashing with bcryptjs (#1) ──
const BCRYPT_ROUNDS = 10;

/** Hash a password with bcrypt. Used for new passwords. */
async function hashPassword(pw) {
  return bcrypt.hash(pw, BCRYPT_ROUNDS);
}

/**
 * Verify a password against an account's stored hash.
 * Supports both bcrypt hashes and legacy SHA-256 hashes (for migration).
 * If a legacy hash matches, it auto-migrates to bcrypt.
 * Returns { valid: boolean, migrated: boolean }
 */
async function verifyPassword(plainPw, storedHash, account, allAccounts) {
  // Check if this is a bcrypt hash (starts with $2a$, $2b$, or $2y$)
  if (storedHash.startsWith("$2a$") || storedHash.startsWith("$2b$") || storedHash.startsWith("$2y$")) {
    const valid = await bcrypt.compare(plainPw, storedHash);
    return { valid, migrated: false };
  }

  // Legacy SHA-256 migration path
  // Old SHA-256 hashes are 64-char hex strings
  if (storedHash.length === 64 && /^[a-f0-9]+$/.test(storedHash)) {
    const sha256Hash = crypto.createHash("sha256").update(plainPw).digest("hex");
    if (sha256Hash === storedHash) {
      // Auto-migrate: re-hash with bcrypt
      if (account && allAccounts) {
        try {
          account.password = await bcrypt.hash(plainPw, BCRYPT_ROUNDS);
          await writeAccounts(allAccounts);
          console.log(`🔄 Auto-migrated password for user: ${account.username}`);
        } catch (e) {
          console.error(`❌ Failed to migrate password for ${account.username}:`, e.message);
        }
      }
      return { valid: true, migrated: true };
    }
  }

  return { valid: false, migrated: false };
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

// Check auth: token-based only (#3: removed legacy password auth)
async function checkAuth(req, res, requireSuper) {
  // Token auth (header only — removed query string to avoid token leaking into logs/history)
  const token = req.headers["x-auth-token"] || "";
  if (token && tokens.has(token)) {
    const session = tokens.get(token);
    if (Date.now() > session.expiresAt) {
      tokens.delete(token);
      persistTokens(); // #2: sync token deletion
      res.status(401).json({ error: "Token expired" });
      return null;
    }
    // Refresh expiry
    session.expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    persistTokens(); // #2: sync token refresh
    if (requireSuper && session.role !== "super_admin") {
      res.status(403).json({ error: "Super admin required" });
      return null;
    }
    return session;
  }

  res.status(401).json({ error: "Unauthorized" });
  return null;
}

// ── Middleware ──
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline scripts/styles for SPA
  crossOriginEmbedderPolicy: false, // Allow external images (app icons)
}));
app.use(compression());
app.use(express.json({ limit: "1mb" }));

// Login rate limiter: max 5 attempts per minute per IP
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "Too many login attempts. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// #9: File size limit error handling
app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "文件大小超过10MB限制" });
  }
  next(err);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AUTH ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Login
app.post("/api/auth/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  const accounts = await readAccounts();
  const account = accounts.find(a => a.username === username);
  if (!account) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  // #1: Use bcrypt verify with auto-migration
  const { valid } = await verifyPassword(password, account.password, account, accounts);
  if (!valid) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = generateToken();
  tokens.set(token, {
    username: account.username,
    role: account.role,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000
  });
  persistTokens(); // #2: persist new token

  res.json({
    success: true,
    token,
    username: account.username,
    role: account.role
  });
  // #12: Audit login
  writeAudit("login", "accounts", account.id, { username: account.username }, req);
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
  persistTokens(); // #2: sync token deletion
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

  // #1: Use bcrypt verify for current password
  const { valid } = await verifyPassword(currentPassword, account.password, account, accounts);
  if (!valid) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }

  // #1: Hash new password with bcrypt
  account.password = await hashPassword(newPassword);
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
  // #1: Use bcrypt hash for new account
  const newAccount = {
    id: maxId + 1,
    username,
    password: await hashPassword(password),
    role,
    createdAt: new Date().toISOString()
  };
  accounts.push(newAccount);
  await writeAccounts(accounts);

  // #12: Audit
  writeAudit("create", "accounts", newAccount.id, { username: newAccount.username, role: newAccount.role }, req);

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
  // #12: Audit
  writeAudit("update", "accounts", account.id, { role }, req);
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

  // #1: Use bcrypt hash for reset password
  account.password = await hashPassword(newPassword);
  await writeAccounts(accounts);
  // #12: Audit
  writeAudit("update", "accounts", account.id, { action: "reset_password" }, req);
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
  // #12: Audit
  writeAudit("delete", "accounts", req.params.id, { username: account.username }, req);
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

// Get All Offers (public, with pagination)
app.get("/api/offers", async (req, res) => {
  const all = await readOffers();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 200));
  if (!req.query.page && !req.query.limit) return res.json(all); // backward compat
  const start = (page - 1) * limit;
  res.json({ data: all.slice(start, start + limit), total: all.length, page, limit });
});

// Export Offers to Excel (must be before /:id route)
app.get("/api/offers/export", async (req, res) => {
  if (!(await checkAuth(req, res))) return;
  const offers = await readOffers();
  // #12: Audit
  writeAudit("export", "offers", "all", { count: offers.length }, req);
  const headers = ["名称", "平台", "单价", "GEO", "商店链接", "状态", "KPI", "PRT", "PID", "集成方式", "备注"];
  const rows = [headers];
  for (const o of offers) {
    const d = o.details || {};
    rows.push([
      o.name || "",
      o.platform || "",
      o.payout || 0,
      (o.geos || []).join(", "),
      d.storeUrl || "",
      "active",
      d.kpi || "",
      d.prt || "",
      d.payableEvent || "",
      (d.integrations || []).join(", "),
      d.flow || ""
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const colWidths = headers.map((h, i) => {
    let max = h.length;
    rows.forEach(r => { if (r[i] && String(r[i]).length > max) max = String(r[i]).length; });
    return { wch: Math.min(max + 2, 40) };
  });
  ws['!cols'] = colWidths;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Offers");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const filename = `offers_${new Date().toISOString().slice(0,10)}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(buf);
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

// List Submissions (with pagination)
app.get("/api/submissions", async (req, res) => {
  if (!(await checkAuth(req, res))) return;
  const all = await readSubmissions();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 100));
  if (!req.query.page && !req.query.limit) return res.json(all); // backward compat
  const start = (page - 1) * limit;
  res.json({ data: all.slice(start, start + limit), total: all.length, page, limit });
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
  // #12: Audit
  writeAudit("update", "submissions", req.params.id, { status }, req);
  res.json({ success: true });
});

// Batch Delete Submissions
app.delete("/api/submissions/batch", async (req, res) => {
  if (!(await checkAuth(req, res))) return;
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: "ids array required" });
  }
  let submissions = await readSubmissions();
  const idSet = new Set(ids);
  const before = submissions.length;
  submissions = submissions.filter(s => !idSet.has(s.id));
  const deleted = before - submissions.length;
  await writeSubmissions(submissions);
  // #12: Audit
  writeAudit("batch_delete", "submissions", ids.length + " items", { deleted }, req);
  res.json({ success: true, deleted });
});

// Batch Update Submissions
app.patch("/api/submissions/batch", async (req, res) => {
  if (!(await checkAuth(req, res))) return;
  const { ids, updates } = req.body;
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: "ids array required" });
  }
  if (!updates || typeof updates !== "object") {
    return res.status(400).json({ error: "updates object required" });
  }
  if (updates.status && !["new", "viewed", "contacted"].includes(updates.status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  const submissions = await readSubmissions();
  const idSet = new Set(ids);
  let updated = 0;
  for (const sub of submissions) {
    if (idSet.has(sub.id)) {
      if (updates.status !== undefined) sub.status = updates.status;
      updated++;
    }
  }
  await writeSubmissions(submissions);
  // #12: Audit
  writeAudit("batch_update", "submissions", ids.length + " items", { updates, updated }, req);
  res.json({ success: true, updated });
});

// Delete Submission
app.delete("/api/submissions/:id", async (req, res) => {
  if (!(await checkAuth(req, res))) return;
  let submissions = await readSubmissions();
  submissions = submissions.filter(s => s.id !== req.params.id);
  await writeSubmissions(submissions);
  // #12: Audit
  writeAudit("delete", "submissions", req.params.id, {}, req);
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
  // #12: Audit
  writeAudit("update", "offers", req.params.id, { updatedFields: allowedFields.filter(f => req.body[f] !== undefined) }, req);
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
  // #12: Audit
  writeAudit("create", "offers", newOffer.id, { name: newOffer.name, platform: newOffer.platform }, req);
  res.status(201).json({ success: true, offer: newOffer });
});

// Batch Delete Offers
app.delete("/api/offers/batch", async (req, res) => {
  if (!(await checkAuth(req, res))) return;
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: "ids array required" });
  }
  let offers = await readOffers();
  const idSet = new Set(ids.map(id => parseInt(id)));
  const before = offers.length;
  offers = offers.filter(o => !idSet.has(o.id));
  const deleted = before - offers.length;
  await writeOffers(offers);
  // #12: Audit
  writeAudit("batch_delete", "offers", ids.length + " items", { deleted }, req);
  res.json({ success: true, deleted });
});

// Batch Update Offers
app.patch("/api/offers/batch", async (req, res) => {
  if (!(await checkAuth(req, res))) return;
  const { ids, updates } = req.body;
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: "ids array required" });
  }
  if (!updates || typeof updates !== "object") {
    return res.status(400).json({ error: "updates object required" });
  }
  const allowedFields = ["name", "platform", "payout", "currency", "geos", "icon", "iconLetter", "details"];
  const updateFields = Object.keys(updates).filter(k => allowedFields.includes(k));
  if (!updateFields.length) {
    return res.status(400).json({ error: "No valid fields to update" });
  }
  const offers = await readOffers();
  const idSet = new Set(ids.map(id => parseInt(id)));
  let updated = 0;
  for (const offer of offers) {
    if (idSet.has(offer.id)) {
      updateFields.forEach(field => { offer[field] = updates[field]; });
      updated++;
    }
  }
  await writeOffers(offers);
  // #12: Audit
  writeAudit("batch_update", "offers", ids.length + " items", { updateFields, updated }, req);
  res.json({ success: true, updated });
});

// Delete Offer
app.delete("/api/offers/:id", async (req, res) => {
  if (!(await checkAuth(req, res))) return;
  let offers = await readOffers();
  const before = offers.length;
  offers = offers.filter(o => o.id !== parseInt(req.params.id));
  if (offers.length === before) return res.status(404).json({ error: "Not found" });
  await writeOffers(offers);
  // #12: Audit
  writeAudit("delete", "offers", req.params.id, {}, req);
  res.json({ success: true });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ORDER EMAIL API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Get all orders (with pagination)
app.get("/api/orders", async (req, res) => {
  if (!(await checkAuth(req, res))) return;
  const all = await readOrders();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 100));
  if (!req.query.page && !req.query.limit) return res.json(all); // backward compat
  const start = (page - 1) * limit;
  res.json({ data: all.slice(start, start + limit), total: all.length, page, limit });
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

  // #12: Audit
  writeAudit("create", "orders", order.id, { publisher, offerName, status: "saved" }, req);

  // Auto-update submission status to "contacted"
  if (order.submissionId) {
    try {
      const subs = await readSubmissions();
      const sub = subs.find(s => s.id === order.submissionId);
      if (sub && sub.status !== "contacted") {
        sub.status = "contacted";
        await writeSubmissions(subs);
      }
    } catch (e) {
      console.error("❌ Auto-update submission status failed:", e.message); // #11
    }
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

  // #12: Audit
  writeAudit("create", "orders", order.id, { publisher, offerName, status: "sending" }, req);

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
    } catch (e) {
      console.error("❌ Auto-update submission status failed:", e.message); // #11
    }
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
  // #12: Audit
  writeAudit("import", "orders", added + " items", { added, skipped, total: existing.length }, req);
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
  // #12: Audit
  writeAudit("update", "orders", req.params.id, { status: req.body.status, notes: req.body.notes !== undefined }, req);
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
  // #12: Audit
  writeAudit("delete", "orders", req.params.id, {}, req);
  res.json({ success: true });
});

// Export managed orders to Excel (#24: auto column width)
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

  // #24: Auto-fit column widths
  const colWidths = headers.map((h, i) => {
    let max = h.length;
    rows.forEach(r => { if (r[i] && String(r[i]).length > max) max = String(r[i]).length; });
    return { wch: Math.min(max + 2, 40) };
  });
  ws['!cols'] = colWidths;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "订单管理");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  const filename = `orders_${new Date().toISOString().slice(0,10)}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`); // Chinese filename
  res.send(buf);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PUB BILL CATEGORIZATION (PUB账单分类)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// In-memory store for split results (keyed by session token hash)
const pubSplitCache = new Map();

// #8: Periodic cache cleanup (every 10 min, expire after 30 min)
function cleanPubSplitCache() {
  const now = Date.now();
  const MAX_AGE = 30 * 60 * 1000; // 30 minutes
  let cleaned = 0;
  for (const [key, val] of pubSplitCache) {
    if (now - val.createdAt > MAX_AGE) {
      try { if (val.path) fs.unlinkSync(val.path); } catch (_) {}
      pubSplitCache.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} expired PUB split cache entries`);
}
setInterval(cleanPubSplitCache, 10 * 60 * 1000);

// #4: PUB账单 split API now requires auth
app.post("/api/pub-bills/split", upload.single("file"), async (req, res) => {
  const session = await checkAuth(req, res);
  if (!session) return;

  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  let wb, sheets;
  try {
    wb = XLSX.readFile(req.file.path, { type: "file", codepage: 65001 });
    sheets = wb.SheetNames;
    if (!sheets.length) throw new Error("Empty workbook");
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(400).json({ error: "无法解析 Excel 文件: " + e.message }); // #11: Chinese error
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

// #4: PUB账单 download API now requires auth
app.get("/api/pub-bills/download/:id", async (req, res) => {
  const session = await checkAuth(req, res);
  if (!session) return;

  const info = pubSplitCache.get(req.params.id);
  if (!info) return res.status(404).json({ error: "结果已过期，请重新上传" }); // #11: Chinese error

  try {
    const buf = fs.readFileSync(info.path);
    const filename = `PUB_${info.customers}customers_${new Date().toISOString().slice(0,10)}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`); // Chinese filename
    res.send(buf);
  } catch (e) {
    console.error("❌ PUB bill download failed:", e.message); // #11
    res.status(500).json({ error: "文件读取失败" }); // #11: Chinese error
  } finally {
    try { fs.unlinkSync(info.path); } catch (_) {}
    pubSplitCache.delete(req.params.id);
  }
});

// ── Stats Trend API (7-day daily counts) ──
app.get("/api/stats/trend", async (req, res) => {
  const session = await checkAuth(req, res);
  if (!session) return;

  const now = new Date();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    days.push(d);
  }

  const offers = await readOffers();
  const submissions = await readSubmissions();
  const orders = await readOrders();

  const offersTrend = days.map(dayStart => {
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    return offers.filter(o => {
      const created = new Date(o.createdAt || o.id || 0);
      return created >= dayStart && created < dayEnd;
    }).length;
  });

  const submissionsTrend = days.map(dayStart => {
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    return submissions.filter(s => {
      const created = new Date(s.timestamp || 0);
      return created >= dayStart && created < dayEnd;
    }).length;
  });

  const ordersTrend = days.map(dayStart => {
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    return orders.filter(o => {
      const created = new Date(o.createdAt || 0);
      return created >= dayStart && created < dayEnd;
    }).length;
  });

  res.json({
    offers: offersTrend,
    submissions: submissionsTrend,
    orders: ordersTrend
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AUDIT LOG API (#12)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get("/api/audit", async (req, res) => {
  if (!(await checkAuth(req, res))) return;
  let audit = await readAuditLog();

  // Filter by target
  if (req.query.target) {
    audit = audit.filter(a => a.target === req.query.target);
  }
  // Filter by action
  if (req.query.action) {
    audit = audit.filter(a => a.action === req.query.action);
  }

  // Sort by timestamp descending (newest first)
  audit.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const start = (page - 1) * limit;
  const data = audit.slice(start, start + limit);

  res.json({ data, total: audit.length, page, limit });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DATA BACKUP / RESTORE (#15)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get("/api/backup", async (req, res) => {
  if (!(await checkAuth(req, res))) return;

  try {
    const backup = {
      _meta: {
        version: "1.0",
        createdAt: new Date().toISOString(),
        source: useGitHub ? "github" : "local"
      },
      offers: await readOffers(),
      submissions: await readSubmissions(),
      managed_orders: await readManagedOrders(),
      accounts: (await readAccounts()).map(a => ({ ...a, password: "[REDACTED]" })),
      audit: await readAuditLog()
    };

    // #12: Audit
    writeAudit("export", "backup", "all", { offers: backup.offers.length, submissions: backup.submissions.length }, req);

    const filename = `mobireach_backup_${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.json(backup);
  } catch (e) {
    console.error("❌ Backup failed:", e.message);
    res.status(500).json({ error: "Backup failed: " + e.message });
  }
});

app.post("/api/restore", upload.single("file"), async (req, res) => {
  const session = await checkAuth(req, res, true); // super_admin only
  if (!session) return;

  if (!req.file) return res.status(400).json({ error: "No backup file uploaded" });

  try {
    const filePath = req.file.path;
    let backup;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      backup = JSON.parse(content);
    } catch (e) {
      try { fs.unlinkSync(filePath); } catch (_) {}
      return res.status(400).json({ error: "Invalid backup file: " + e.message });
    }

    // Validate backup structure
    if (!backup._meta || !backup.offers || !backup.submissions) {
      try { fs.unlinkSync(filePath); } catch (_) {}
      return res.status(400).json({ error: "Invalid backup format: missing _meta, offers, or submissions" });
    }

    // Create snapshot of current data before restore
    const snapshot = {
      _meta: {
        version: "1.0",
        createdAt: new Date().toISOString(),
        type: "pre-restore-snapshot"
      },
      offers: await readOffers(),
      submissions: await readSubmissions(),
      managed_orders: await readManagedOrders(),
      accounts: await readAccounts(),
      audit: await readAuditLog()
    };
    const snapshotDir = path.join(DATA_DIR, "snapshots");
    if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });
    const snapshotPath = path.join(snapshotDir, `snapshot_${Date.now()}.json`);
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf-8");

    // Restore data
    if (backup.offers) await writeOffers(backup.offers);
    if (backup.submissions) await writeSubmissions(backup.submissions);
    if (backup.managed_orders) await writeManagedOrders(backup.managed_orders);
    if (backup.accounts && backup.accounts.length) {
      // Preserve existing passwords if backup has redacted passwords
      const currentAccounts = await readAccounts();
      const restored = backup.accounts.map(a => {
        if (a.password === "[REDACTED]") {
          const existing = currentAccounts.find(ca => ca.id === a.id);
          if (existing) return { ...a, password: existing.password };
        }
        return a;
      });
      await writeAccounts(restored);
    }

    // Clean up uploaded file
    try { fs.unlinkSync(filePath); } catch (_) {}

    // #12: Audit
    writeAudit("import", "backup", "all", {
      source: backup._meta.createdAt,
      offers: (backup.offers || []).length,
      submissions: (backup.submissions || []).length,
      snapshotPath
    }, req);

    res.json({
      success: true,
      restored: {
        offers: (backup.offers || []).length,
        submissions: (backup.submissions || []).length,
        managed_orders: (backup.managed_orders || []).length,
        accounts: (backup.accounts || []).length
      },
      snapshot: snapshotPath
    });
  } catch (e) {
    console.error("❌ Restore failed:", e.message);
    res.status(500).json({ error: "Restore failed: " + e.message });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  EMAIL TEMPLATES API (#16)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get("/api/email-templates", async (req, res) => {
  if (!(await checkAuth(req, res))) return;
  const templates = await readEmailTemplates();
  res.json(templates);
});

app.post("/api/email-templates", async (req, res) => {
  if (!(await checkAuth(req, res))) return;
  const { id, name, subject, body } = req.body;
  if (!id || !name || !subject || !body) {
    return res.status(400).json({ error: "id, name, subject and body are required" });
  }
  // id must be alphanumeric + underscore
  if (!/^[a-zA-Z0-9_]+$/.test(id)) {
    return res.status(400).json({ error: "Template ID must be alphanumeric (letters, numbers, underscore)" });
  }
  const templates = await readEmailTemplates();
  if (templates[id]) {
    return res.status(409).json({ error: "Template ID already exists" });
  }
  templates[id] = { name, subject, body };
  await writeEmailTemplatesData(templates);
  // #12: Audit
  writeAudit("create", "email_templates", id, { name }, req);
  res.status(201).json({ success: true, templates });
});

app.put("/api/email-templates/:id", async (req, res) => {
  if (!(await checkAuth(req, res))) return;
  const templates = await readEmailTemplates();
  const tid = req.params.id;
  if (!templates[tid]) {
    return res.status(404).json({ error: "Template not found" });
  }
  const { name, subject, body } = req.body;
  if (name) templates[tid].name = name;
  if (subject) templates[tid].subject = subject;
  if (body) templates[tid].body = body;
  await writeEmailTemplatesData(templates);
  // #12: Audit
  writeAudit("update", "email_templates", tid, { name, subject: !!subject, body: !!body }, req);
  res.json({ success: true, templates });
});

app.delete("/api/email-templates/:id", async (req, res) => {
  if (!(await checkAuth(req, res))) return;
  const templates = await readEmailTemplates();
  const tid = req.params.id;
  if (!templates[tid]) {
    return res.status(404).json({ error: "Template not found" });
  }
  if (tid === "default") {
    return res.status(400).json({ error: "Cannot delete the default template" });
  }
  const deleted = templates[tid].name;
  delete templates[tid];
  await writeEmailTemplatesData(templates);
  // #12: Audit
  writeAudit("delete", "email_templates", tid, { name: deleted }, req);
  res.json({ success: true, templates });
});

// ── Admin Page ──
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

// ── Static files (after API routes) ──
app.use(express.static(__dirname));

// ── Global error handler (must be last middleware) ──
app.use((err, req, res, next) => {
  // Multer file-size errors already handled above, but catch anything else
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large" });
  }
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "文件大小超过10MB限制" });
  }
  console.error("🔥 Unhandled error:", err.stack || err);
  res.status(500).json({ error: "Internal server error" });
});

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
      if (!fs.existsSync(LOCAL_AUDIT)) {
        fs.writeFileSync(LOCAL_AUDIT, "[]", "utf-8");
      }
      if (!fs.existsSync(LOCAL_EMAIL_TEMPLATES)) {
        const defaultTemplates = {
          default: {
            name: "默认模板",
            subject: "MobiReach - {offerName} Offer Details",
            body: "Hi {publisher},\n\nHere are the details for {offerName}...\n\nPayout: {payout}\nGEO: {geo}\n\nBest regards,\nMobiReach Team"
          }
        };
        fs.writeFileSync(LOCAL_EMAIL_TEMPLATES, JSON.stringify(defaultTemplates, null, 2), "utf-8");
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
