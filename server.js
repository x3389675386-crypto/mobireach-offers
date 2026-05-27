const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "mobireach2026";

// ── Persistent data directory ──
// On Render: set DATA_DIR=/var/data and mount a persistent disk there.
// Locally defaults to ./data/ (gitignored).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const SUBMISSIONS_FILE = path.join(DATA_DIR, "submissions.json");
const OFFERS_FILE = path.join(DATA_DIR, "offers.json");
const OFFERS_SEED = path.join(__dirname, "offers-seed.json");

// Initialize data directory on first run
function initData() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(OFFERS_FILE) && fs.existsSync(OFFERS_SEED)) {
    fs.copyFileSync(OFFERS_SEED, OFFERS_FILE);
    console.log("📋 Offers initialized from seed");
  }
  if (!fs.existsSync(SUBMISSIONS_FILE)) {
    fs.writeFileSync(SUBMISSIONS_FILE, "[]", "utf-8");
    console.log("📋 Submissions initialized (empty)");
  }
}
initData();

// ── Middleware ──
app.use(express.json());

// ── Helpers: Submissions ──
function readSubmissions() {
  try {
    return JSON.parse(fs.readFileSync(SUBMISSIONS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function writeSubmissions(data) {
  fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// ── Helpers: Offers ──
function readOffers() {
  try {
    return JSON.parse(fs.readFileSync(OFFERS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function writeOffers(data) {
  fs.writeFileSync(OFFERS_FILE, JSON.stringify(data, null, 2), "utf-8");
}

function checkAdmin(req, res) {
  const pw = req.query.password || req.headers["x-admin-password"] || "";
  if (pw !== ADMIN_PASSWORD) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// ── API: Submit Application ──
app.post("/api/apply", (req, res) => {
  const { publisher, pids, emails, handshake, comment, offerName, offerPlatform } = req.body;

  // Validate
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
    status: "new" // new | viewed | contacted
  };

  const submissions = readSubmissions();
  submissions.unshift(submission); // newest first
  writeSubmissions(submissions);

  console.log(`✅ New application: ${publisher} → ${offerName} (${offerPlatform})`);
  res.json({ success: true, id: submission.id });
});

// ── API: List Submissions (admin) ──
app.get("/api/submissions", (req, res) => {
  if (!checkAdmin(req, res)) return;
  res.json(readSubmissions());
});

// ── API: Update Status (admin) ──
app.patch("/api/submissions/:id/status", (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { status } = req.body;
  if (!["new", "viewed", "contacted"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  const submissions = readSubmissions();
  const idx = submissions.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  submissions[idx].status = status;
  writeSubmissions(submissions);
  res.json({ success: true });
});

// ── API: Delete Submission (admin) ──
app.delete("/api/submissions/:id", (req, res) => {
  if (!checkAdmin(req, res)) return;
  let submissions = readSubmissions();
  submissions = submissions.filter(s => s.id !== req.params.id);
  writeSubmissions(submissions);
  res.json({ success: true });
});

// ── API: Get All Offers (public) ──
app.get("/api/offers", (req, res) => {
  res.json(readOffers());
});

// ── API: Get Single Offer (public) ──
app.get("/api/offers/:id", (req, res) => {
  const offers = readOffers();
  const offer = offers.find(o => o.id === parseInt(req.params.id));
  if (!offer) return res.status(404).json({ error: "Not found" });
  res.json(offer);
});

// ── API: Update Offer (admin) ──
app.put("/api/offers/:id", (req, res) => {
  if (!checkAdmin(req, res)) return;
  const offers = readOffers();
  const idx = offers.findIndex(o => o.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: "Not found" });

  const allowedFields = ["name", "platform", "payout", "currency", "geos", "icon", "iconLetter", "details"];
  const updates = req.body;
  allowedFields.forEach(field => {
    if (updates[field] !== undefined) {
      offers[idx][field] = updates[field];
    }
  });

  writeOffers(offers);
  res.json({ success: true, offer: offers[idx] });
});

// ── API: Create Offer (admin) ──
app.post("/api/offers", (req, res) => {
  if (!checkAdmin(req, res)) return;
  const offers = readOffers();
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
  writeOffers(offers);
  res.status(201).json({ success: true, offer: newOffer });
});

// ── API: Delete Offer (admin) ──
app.delete("/api/offers/:id", (req, res) => {
  if (!checkAdmin(req, res)) return;
  let offers = readOffers();
  const before = offers.length;
  offers = offers.filter(o => o.id !== parseInt(req.params.id));
  if (offers.length === before) return res.status(404).json({ error: "Not found" });
  writeOffers(offers);
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
