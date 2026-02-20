const fs = require("fs");
const path = require("path");
const { MerkleTree } = require("merkletreejs");
const { keccak256, solidityPacked } = require("ethers");

const SAMPLE_PATH = path.join(__dirname, "..", "data", "sample-accounts.json");
const OUTPUT_PATH = path.join(__dirname, "..", "public", "airdrop.json");

const CLAIM_AMOUNT = "100";

function hashAddress(address) {
  if (!address || typeof address !== "string") {
    throw new Error(`Invalid address: ${address}`);
  }
  const addressRegex = /^0x[a-fA-F0-9]{40}$/;
  if (!addressRegex.test(address)) {
    throw new Error(`Invalid Ethereum address format: ${address}`);
  }
  const packed = solidityPacked(["address"], [address]);
  const hex = keccak256(packed);
  return Buffer.from(hex.slice(2), "hex");
}

function buildTree(entries) {
  const leaves = entries.map((entry) => hashAddress(entry.address));
  const tree = new MerkleTree(leaves, (data) => {
    const hex = keccak256(data);
    return Buffer.from(hex.slice(2), "hex");
  }, { sortPairs: true });

  return { tree, leaves };
}

function main() {
  try {
    if (!fs.existsSync(SAMPLE_PATH)) {
      throw new Error(`Sample accounts file not found: ${SAMPLE_PATH}`);
    }
    
    const rawData = fs.readFileSync(SAMPLE_PATH, "utf8");
    const entries = JSON.parse(rawData);
    
    if (!Array.isArray(entries)) {
      throw new Error("Sample accounts must be an array");
    }
    
    if (entries.length === 0) {
      throw new Error("Sample accounts array is empty");
    }
    
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry.address || typeof entry.address !== "string") {
        throw new Error(`Invalid entry at index ${i}: missing or invalid address`);
      }
      try {
        hashAddress(entry.address);
      } catch (err) {
        throw new Error(`Invalid entry at index ${i}: ${err.message}`);
      }
    }
    
    const { tree, leaves } = buildTree(entries);

    const proofs = entries.reduce((acc, entry, idx) => {
      acc[entry.address.toLowerCase()] = tree.getHexProof(leaves[idx]);
      return acc;
    }, {});

    const payload = {
      token: {
        name: "Fair Coin",
        symbol: "FAIR",
        decimals: 18
      },
      claimAmount: CLAIM_AMOUNT,
      merkleRoot: tree.getHexRoot(),
      claims: entries.map((entry) => ({
        address: entry.address,
        proof: proofs[entry.address.toLowerCase()]
      }))
    };

    fs.mkdirSync(path.join(__dirname, "..", "public"), { recursive: true });
    if (fs.existsSync(OUTPUT_PATH)) {
      fs.copyFileSync(OUTPUT_PATH, OUTPUT_PATH + ".bak");
    }
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));

    console.log(`Wrote merkle root ${payload.merkleRoot} with ${entries.length} leaves to public/airdrop.json`);
  } catch (err) {
    console.error("Error building Merkle tree:", err.message);
    process.exit(1);
  }
}

main();
