const path = require("path");
const express = require("express");
const Database = require("better-sqlite3");
const fs = require("fs");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { ethers } = require("ethers");

const PORT = process.env.PORT || 4173;
const DB_PATH = path.join(__dirname, "airdrop.db");
const AIRDROP_JSON = path.join(__dirname, "..", "public", "airdrop.json");

function validateConfig() {
  if (typeof PORT !== 'string' && typeof PORT !== 'number') {
    throw new Error(`Invalid PORT configuration: ${PORT}`);
  }
  const portNum = parseInt(PORT, 10);
  if (isNaN(portNum) || portNum <= 0 || portNum > 65535) {
    throw new Error(`PORT must be a valid port number (1-65535): ${PORT}`);
  }
}

function initDb() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS merkle_root (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      root TEXT NOT NULL,
      claim_amount TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS claims (
      address TEXT PRIMARY KEY COLLATE NOCASE,
      proof TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_claims_address ON claims(address);
  `);

  const row = db.prepare("SELECT root FROM merkle_root WHERE id = 1").get();
  if (!row) {
    try {
      if (!fs.existsSync(AIRDROP_JSON)) {
        throw new Error(`Airdrop file not found: ${AIRDROP_JSON}`);
      }
      const raw = JSON.parse(fs.readFileSync(AIRDROP_JSON, "utf8"));
      if (!raw.merkleRoot) {
        throw new Error("Invalid airdrop.json: missing merkleRoot");
      }
      const insertRoot = db.prepare("INSERT INTO merkle_root (id, root, claim_amount) VALUES (1, ?, ?)");
      insertRoot.run(raw.merkleRoot.toLowerCase(), raw.claimAmount || "100");

      const insertClaim = db.prepare("INSERT INTO claims (address, proof) VALUES (?, ?)");
      const entries = raw.claims || [];
      const tx = db.transaction(() => {
        for (const c of entries) {
          const address = String(c.address).toLowerCase();
          const addressRegex = /^0x[a-f0-9]{40}$/;
          if (!addressRegex.test(address)) {
            throw new Error(`Invalid address format: ${address}`);
          }
          const proof = c.proof || [];
          if (!Array.isArray(proof) || proof.some(item => !item || typeof item !== "string" || item.length !== 66)) {
            throw new Error(`Invalid proof format for address: ${address}`);
          }
          insertClaim.run(address, JSON.stringify(proof));
        }
      });
      tx();
      console.log(`Seeded DB with root ${raw.merkleRoot} and ${entries.length} claims.`);
    } catch (err) {
      console.error("Failed to seed database:", err.message);
      throw err;
    }
  }

  return db;
}

function createServer() {
  validateConfig();
  const db = initDb();
  const app = express();
  
  app.use(helmet());
  app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    req.setTimeout(30000);
    next();
  });

  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: "Too many requests from this IP, please try again later." }
  });

  app.use("/api", apiLimiter);
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/api/eligibility", (req, res) => {
    try {
      const address = String(req.query.address || "").trim();
      try {
        ethers.getAddress(address);
      } catch {
        return res.status(400).json({ error: "Invalid Ethereum address format" });
      }
      const normalizedAddress = address.toLowerCase();

      const rootRow = db.prepare("SELECT root, claim_amount FROM merkle_root WHERE id = 1").get();
      if (!rootRow) {
        console.error("Merkle root not found in database");
        return res.status(500).json({ error: "Merkle root not configured" });
      }

      const claimRow = db.prepare("SELECT proof FROM claims WHERE address = ?").get(normalizedAddress);
      const qualified = !!claimRow;
      const proof = claimRow ? JSON.parse(claimRow.proof) : [];

      if (claimRow && (!Array.isArray(proof) || proof.some(item => !item || typeof item !== "string" || item.length !== 66))) {
        console.error("Invalid proof format in database for address");
        return res.status(500).json({ error: "Invalid proof data" });
      }

      res.json({
        qualified,
        address: normalizedAddress,
        merkleRoot: rootRow.root,
        claimAmount: rootRow.claim_amount,
        proof,
      });
    } catch (err) {
      console.error("Eligibility check error:", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.listen(PORT, () => {
    console.log(`FairCoin API/UI running on http://localhost:${PORT}`);
  });
}

createServer();
