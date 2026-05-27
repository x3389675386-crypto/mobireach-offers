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
  // Init local data dir
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LOCAL_OFFERS) && fs.existsSync(OFFERS_SEED)) {
    fs.copyFileSync(OFFERS_SEED, LOCAL_OFFERS);
  }
  if (!fs.existsSync(LOCAL_SUBMISSIONS)) {
    fs.writeFileSync(LOCAL_SUBMISSIONS, "[]", "utf-8");
  }
}

// ── In-memory cache ──
let offersCache = null;
let submissionsCache = null;

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
  } catch (e) {
    // file doesn't exist yet — first write
  }

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
async function readOffers() {
  if (offersCache) return offersCache;

  if (useGitHub) {
    const data = await ghRead("offers.json");
    if (data) { offersCache = data; return data; }
    // GitHub empty: seed from local file
    if (fs.existsSync(OFFERS_SEED)) {
      const seed = JSON.parse(fs.readFileSync(OFFERS_SEED, "utf-8"));
      await ghWrite("offers.json", seed);
      offersCache = seed;
      return seed;
    }
    return [];
  }

  // Local fallback
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

function checkAdmin(req, res) {
  const pw = req.query.password || req.headers["x-admin-password"] || "";
  if (pw !== ADMIN_PASSWORD) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// ── Middleware ──
app.use(express.json());

// ── API: Submit Application ──
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

// ── API: List Submissions (admin) ──
app.get("/api/submissions", async (req, res) => {
  if (!checkAdmin(req, res)) return;
  res.json(await readSubmissions());
});

// ── API: Update Status (admin) ──
app.patch("/api/submissions/:id/status", async (req, res) => {
  if (!checkAdmin(req, res)) return;
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

// ── API: Delete Submission (admin) ──
app.delete("/api/submissions/:id", async (req, res) => {
  if (!checkAdmin(req, res)) return;
  let submissions = await readSubmissions();
  submissions = submissions.filter(s => s.id !== req.params.id);
  await writeSubmissions(submissions);
  res.json({ success: true });
});

// ── API: Get All Offers (public) ──
app.get("/api/offers", async (req, res) => {
  res.json(await readOffers());
});

// ── API: Get Single Offer (public) ──
app.get("/api/offers/:id", async (req, res) => {
  const offers = await readOffers();
  const offer = offers.find(o => o.id === parseInt(req.params.id));
  if (!offer) return res.status(404).json({ error: "Not found" });
  res.json(offer);
});

// ── API: Update Offer (admin) ──
app.put("/api/offers/:id", async (req, res) => {
  if (!checkAdmin(req, res)) return;
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

// ── API: Create Offer (admin) ──
app.post("/api/offers", async (req, res) => {
  if (!checkAdmin(req, res)) return;
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

// ── API: Delete Offer (admin) ──
app.delete("/api/offers/:id", async (req, res) => {
  if (!checkAdmin(req, res)) return;
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
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   Mobireach Server is running!       ║
  ║                                      ║
  ║   🌐  Site:  http://localhost:${PORT}   ║
  ║   📊  Admin: http://localhost:${PORT}/admin ║
  ║   🔑  Password: ${ADMIN_PASSWORD}        ║
  ╚══════════════════════════════════════╝
  `);
});
