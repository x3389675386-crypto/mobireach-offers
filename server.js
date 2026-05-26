const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "submissions.json");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "mobireach2026";

// ── Middleware ──
app.use(express.json());
app.use(express.static(__dirname));

// ── Helpers ──
function readSubmissions() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function writeSubmissions(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
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
  const pw = req.query.password || req.headers["x-admin-password"] || "";
  if (pw !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const submissions = readSubmissions();
  res.json(submissions);
});

// ── API: Update Status (admin) ──
app.patch("/api/submissions/:id/status", (req, res) => {
  const pw = req.query.password || req.headers["x-admin-password"] || "";
  if (pw !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
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
  const pw = req.query.password || req.headers["x-admin-password"] || "";
  if (pw !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  let submissions = readSubmissions();
  submissions = submissions.filter(s => s.id !== req.params.id);
  writeSubmissions(submissions);
  res.json({ success: true });
});

// ── Admin Page ──
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

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
