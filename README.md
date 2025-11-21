# Fair Coin (FAIR) Merkle Airdrop + AMM Demo

This repo contains:
- A Solidity token that is both an ERC20 and an ownerless constant-product market maker (CPMM).
- A Merkle-guarded claim flow that mints 100 FAIR per address (95 FAIR to claimer, 5 FAIR to the pool).
- A lightweight web UI that shows sample allowlist entries, builds/verifies proofs, and simulates ETH/FAIR trades.

## Quick start
```bash
npm install          # already run once for you
npm run build:merkle # rebuild public/airdrop.json from data/sample-accounts.json
npm run dev          # serve API + UI at http://localhost:4173
```

The server seeds an SQLite DB (`server/airdrop.db`) from `public/airdrop.json`, exposes `/api/eligibility?address=0x...`, and serves the UI. Swap in your production allowlist and rerun `npm run build:merkle` to refresh the Merkle root + proofs and seed the DB.

## Smart contract
- `contracts/FairCoin.sol` (Solidity ^0.8.20)
  - `claim(bytes32[] proof)`: verifies `keccak256(abi.encodePacked(msg.sender))` against the Merkle root. Mints 100 FAIR; 95 FAIR to caller, 5 FAIR to the pool (the contract itself).
  - AMM: the token contract holds FAIR/ETH reserves and enforces constant product pricing.
    - `buyFair()` is payable, zero-fee, and sends FAIR out.
    - `sellFair(uint256 amount)` takes 0.1% of FAIR as a fee to the founder, then returns ETH.
    - `donate(uint256 fairAmount)` lets anyone push FAIR and/or ETH into the pool.
  - `founder` receives the 0.1% sell fee. Pool state is synced on every state-changing action.

## Frontend
- `public/index.html`, `public/styles.css`, `public/app.js`.
- Uses local `public/vendor/ethers.min.js` (no external CDNs).
- Simplified claim-only UX: connect wallet, check eligibility (server tells you if an address is whitelisted), load proof, sign ownership message.
- Proof verification mirrors the on-chain logic: `keccak256(abi.encodePacked(address))` with sorted pair hashing.

## Sample data
- `data/sample-accounts.json` ships with 4 Hardhat/Anvil dev keys (never use in production).
- `scripts/buildMerkle.js` builds the Merkle tree with `merkletreejs`, writes `public/airdrop.json`.
- In production, drop the private keys, expand the address list, and keep proofs on the server side.

## Next steps for production
1. Replace the sample list with the real allowlist (addresses only), regenerate the Merkle root (`npm run build:merkle`), and restart `npm run dev` to reseed the DB.
2. Plug in contract calls for `claim` (and optionally trading) using the fetched proof + wallet signature.
3. Add auth for login (session/JWT) and rate-limit eligibility checks.
4. Add tests for the eligibility API and contract integration; consider formal verification for the fee path.

## MetaMask testing guide
- Import one of the dev keys in `data/sample-accounts.json` into MetaMask (never fund them on mainnet).
- Run `npm run serve` and visit `http://localhost:4173`.
- Click **Connect MetaMask**, choose the imported account, then **Build proof** (select the same account) and **Verify proof**.
- Click **Sign ownership message** to sign `Fair Coin claim ownership check` containing your address + Merkle root. This mimics the signature to send alongside the Merkle proof.
- If you have multiple wallet extensions, click **Detect wallets (EIP-6963)** and pick MetaMask (or another) in the dropdown before connecting.
