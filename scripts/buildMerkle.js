const fs = require("fs");
const path = require("path");
const { MerkleTree } = require("merkletreejs");
const { keccak256, solidityPacked } = require("ethers");

const SAMPLE_PATH = path.join(__dirname, "..", "data", "sample-accounts.json");
const OUTPUT_PATH = path.join(__dirname, "..", "public", "airdrop.json");

const CLAIM_AMOUNT = "100"; // FAIR to mint on claim

function hashAddress(address) {
  // keccak256(abi.encodePacked(address))
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
  const entries = JSON.parse(fs.readFileSync(SAMPLE_PATH, "utf8"));
  const { tree, leaves } = buildTree(entries);

  const proofs = {};
  entries.forEach((entry, idx) => {
    const proof = tree.getHexProof(leaves[idx]);
    proofs[entry.address.toLowerCase()] = proof;
  });

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
      privateKey: entry.privateKey,
      proof: proofs[entry.address.toLowerCase()]
    }))
  };

  fs.mkdirSync(path.join(__dirname, "..", "public"), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));

  console.log(`Wrote merkle root ${payload.merkleRoot} with ${entries.length} leaves to public/airdrop.json`);
}

main();
