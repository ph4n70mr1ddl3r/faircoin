const path = require("path");
const express = require("express");
const Database = require("better-sqlite3");
const fs = require("fs");

const PORT = process.env.PORT || 4173;
const DB_PATH = path.join(__dirname, "airdrop.db");
const AIRDROP_JSON = path.join(__dirname, "..", "public", "airdrop.json");

function initDb() {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS merkle_root (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      root TEXT NOT NULL,
      claim_amount TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS claims (
      address TEXT PRIMARY KEY,
      proof TEXT NOT NULL
    );
  `);

  const row = db.prepare("SELECT root FROM merkle_root WHERE id = 1").get();
  if (!row) {
    const raw = JSON.parse(fs.readFileSync(AIRDROP_JSON, "utf8"));
    const insertRoot = db.prepare("INSERT INTO merkle_root (id, root, claim_amount) VALUES (1, ?, ?)");
    insertRoot.run(raw.merkleRoot.toLowerCase(), raw.claimAmount || "100");

    const insertClaim = db.prepare("INSERT INTO claims (address, proof) VALUES (?, ?)");
    const entries = raw.claims || [];
    const tx = db.transaction(() => {
      entries.forEach((c) => {
        insertClaim.run(c.address.toLowerCase(), JSON.stringify(c.proof || []));
      });
    });
    tx();
    console.log(`Seeded DB with root ${raw.merkleRoot} and ${entries.length} claims.`);
  }

  return db;
}

function createServer() {
  const db = initDb();
  const app = express();
  app.use(express.json());

  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/api/eligibility", (req, res) => {
    const address = String(req.query.address || "").toLowerCase();
    if (!address || !address.startsWith("0x") || address.length !== 42) {
      return res.status(400).json({ error: "Invalid address" });
    }

    const rootRow = db.prepare("SELECT root, claim_amount FROM merkle_root WHERE id = 1").get();
    if (!rootRow) return res.status(500).json({ error: "Root not set" });

    const claimRow = db.prepare("SELECT proof FROM claims WHERE address = ?").get(address);
    const qualified = !!claimRow;
    res.json({
      qualified,
      address,
      merkleRoot: rootRow.root,
      claimAmount: rootRow.claim_amount,
      proof: claimRow ? JSON.parse(claimRow.proof) : [],
    });
  });

  app.listen(PORT, () => {
    console.log(`FairCoin API/UI running on http://localhost:${PORT}`);
  });
}

createServer();
