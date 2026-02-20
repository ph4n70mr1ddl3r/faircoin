const path = require("path");
const express = require("express");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const fs = require("fs");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { ethers } = require("ethers");

const logger = {
  info: (msg) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`),
  error: (msg) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`),
  warn: (msg) => console.warn(`[WARN] ${new Date().toISOString()} - ${msg}`)
};

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

function isValidMerkleRoot(root) {
  if (!root || typeof root !== 'string') return false;
  return /^0x[a-f0-9]{64}$/i.test(root);
}

function validateAddress(address) {
  if (!address || typeof address !== 'string') {
    return false;
  }
  if (!address.match(/^0x[a-fA-F0-9]{40}$/)) {
    return false;
  }
  try {
    ethers.getAddress(address);
    return true;
  } catch {
    return false;
  }
}

function validateClaimsData(claims) {
  if (!Array.isArray(claims)) {
    throw new Error("Claims must be an array");
  }
  if (claims.length === 0) {
    throw new Error("Claims array cannot be empty");
  }
  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i];
    if (!claim || typeof claim !== 'object') {
      throw new Error(`Claim at index ${i} must be an object`);
    }
    if (!claim.address || typeof claim.address !== 'string') {
      throw new Error(`Claim at index ${i} missing valid address`);
    }
    if (!validateAddress(claim.address)) {
      throw new Error(`Claim at index ${i} has invalid address: ${claim.address}`);
    }
    if (!Array.isArray(claim.proof)) {
      throw new Error(`Claim at index ${i} must have a proof array`);
    }
    for (let j = 0; j < claim.proof.length; j++) {
      const proofItem = claim.proof[j];
      if (!proofItem || typeof proofItem !== 'string' || proofItem.length !== 66 || !isValidMerkleRoot(proofItem)) {
        throw new Error(`Invalid proof format at index ${i}, proof position ${j}`);
      }
    }
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
      if (!isValidMerkleRoot(raw.merkleRoot)) {
        throw new Error("Invalid airdrop.json: invalid merkleRoot format");
      }
      const entries = raw.claims || [];
      validateClaimsData(entries);
      
      const insertRoot = db.prepare("INSERT INTO merkle_root (id, root, claim_amount) VALUES (1, ?, ?)");
      insertRoot.run(raw.merkleRoot.toLowerCase(), raw.claimAmount || "100");

      const insertClaim = db.prepare("INSERT INTO claims (address, proof) VALUES (?, ?)");
      const tx = db.transaction(() => {
        for (const c of entries) {
          const address = String(c.address).toLowerCase();
          insertClaim.run(address, JSON.stringify(c.proof));
        }
      });
      tx();
      logger.info(`Seeded DB with root ${raw.merkleRoot} and ${entries.length} claims.`);
    } catch (err) {
      logger.error(`Failed to seed database: ${err.message}`);
      throw err;
    }
  }

  return db;
}

function createServer() {
  validateConfig();
  const db = initDb();
  const app = express();
  let server = null;

  const gracefulShutdown = (signal) => {
    logger.info(`${signal} received: closing server gracefully...`);
    let shutdownTimer = null;
    if (server) {
      server.close(() => {
        if (shutdownTimer) clearTimeout(shutdownTimer);
        logger.info('Server closed');
        db.close();
        process.exit(0);
      });
    } else {
      db.close();
      process.exit(0);
    }

    shutdownTimer = setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      try {
        db.close();
      } catch (err) {
        logger.error(`Error closing DB during forced shutdown: ${err.message}`);
      }
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err.message}`);
    gracefulShutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled rejection at ${promise}: ${reason}`);
    gracefulShutdown('unhandledRejection');
  });
  
  app.use((req, res, next) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.locals.nonce = nonce;
    res.setHeader('Content-Security-Policy', 
      `default-src 'self'; ` +
      `script-src 'self' 'nonce-${nonce}'; ` +
      `connect-src 'self' https:; ` +
      `img-src 'self' data: https:; ` +
      `style-src 'self' 'unsafe-inline'`
    );
    next();
  });
  app.use(helmet());
  const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean) : [];
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.length === 0) {
        return callback(null, true);
      }
      const isAllowed = allowedOrigins.some(allowed => {
        try {
          return new URL(origin).origin === new URL(allowed).origin;
        } catch {
          return false;
        }
      });
      if (isAllowed) {
        callback(null, true);
      } else {
        logger.warn(`CORS blocked for origin: ${origin}`);
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true
  }));
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    req.setTimeout(30000);
    res.setTimeout(30000);
    next();
  });

  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      logger.warn(`Rate limit exceeded for IP: ${req.ip}`);
      res.status(429).json({ error: "Too many requests from this IP, please try again later." });
    }
  });

  app.use("/api", apiLimiter);
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/health", (req, res) => {
    try {
      const rootRow = db.prepare("SELECT root, claim_amount FROM merkle_root WHERE id = 1").get();
      const claimCount = db.prepare("SELECT COUNT(*) as count FROM claims").get();
      res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        merkleRootConfigured: !!rootRow?.root,
        totalClaims: claimCount?.count || 0
      });
    } catch (err) {
      logger.error(`Health check failed: ${err.message}`);
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  app.get("/api/eligibility", (req, res) => {
    try {
      const address = String(req.query.address || "").trim();
      
      if (!address) {
        logger.warn("Eligibility check attempted with empty address");
        return res.status(400).json({ error: "Address parameter is required" });
      }
      
      if (!validateAddress(address)) {
        logger.warn(`Invalid address format: ${address}`);
        return res.status(400).json({ error: "Invalid Ethereum address format" });
      }
      
      const normalizedAddress = address.toLowerCase();
      logger.info(`Eligibility check for address: ${normalizedAddress}`);

      const rootRow = db.prepare("SELECT root, claim_amount FROM merkle_root WHERE id = 1").get();
      if (!rootRow) {
        logger.error("Merkle root not found in database");
        return res.status(500).json({ error: "Merkle root not configured" });
      }

      if (!isValidMerkleRoot(rootRow.root)) {
        logger.error("Invalid merkle root format in database");
        return res.status(500).json({ error: "Invalid merkle root configuration" });
      }

      const claimRow = db.prepare("SELECT proof FROM claims WHERE address = ?").get(normalizedAddress);
      const qualified = !!claimRow;
      let proof = [];

      if (claimRow) {
        try {
          proof = JSON.parse(claimRow.proof);
          if (!Array.isArray(proof) || proof.some(item => !item || typeof item !== "string" || !item.startsWith("0x") || item.length !== 66 || !isValidMerkleRoot(item))) {
            logger.error("Invalid proof format in database for address");
            return res.status(500).json({ error: "Invalid proof data" });
          }
        } catch (parseError) {
          logger.error(`Failed to parse proof JSON: ${parseError.message}`);
          return res.status(500).json({ error: "Invalid proof data format" });
        }
      }

      res.json({
        qualified,
        address: normalizedAddress,
        merkleRoot: rootRow.root,
        claimAmount: rootRow.claim_amount,
        proof,
      });
    } catch (err) {
      logger.error(`Eligibility check error: ${err.message}`);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.use((err, req, res, next) => {
    logger.error(`Unhandled error: ${err.message}`);
    res.status(500).json({ error: "Internal server error" });
  });

  server = app.listen(PORT, () => {
    logger.info(`FairCoin API/UI running on http://localhost:${PORT}`);
  });
}

createServer();
