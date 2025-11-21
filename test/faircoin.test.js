const { expect } = require("chai");
const { ethers } = require("hardhat");
const { MerkleTree } = require("merkletreejs");
const fs = require("fs");
const path = require("path");

const ONE = 1n;
const WAD = 10n ** 18n;

function loadSample() {
  const raw = fs.readFileSync(path.join(__dirname, "..", "data", "sample-accounts.json"), "utf8");
  return JSON.parse(raw);
}

function leafFor(address) {
  const hash = ethers.keccak256(ethers.solidityPacked(["address"], [address]));
  return Buffer.from(hash.slice(2), "hex");
}

function buildTree(entries) {
  const leaves = entries.map((entry) => leafFor(entry.address));
  const tree = new MerkleTree(
    leaves,
    (data) => Buffer.from(ethers.keccak256(data).slice(2), "hex"),
    { sortPairs: true }
  );
  const proofs = {};
  entries.forEach((entry, idx) => {
    proofs[entry.address.toLowerCase()] = tree.getHexProof(leaves[idx]);
  });
  return { root: tree.getHexRoot(), proofs };
}

function amountOutConstantProduct(amountIn, reserveIn, reserveOut) {
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) return 0n;
  const k = reserveIn * reserveOut;
  return reserveOut - k / (reserveIn + amountIn);
}

describe("FairCoin", function () {
  async function deployFixture() {
    const entries = loadSample();
    const { root, proofs } = buildTree(entries);

    const [deployer, ...signers] = await ethers.getSigners();
    const FairCoin = await ethers.getContractFactory("FairCoin");
    const fair = await FairCoin.deploy(root, deployer.address);
    await fair.waitForDeployment();

    return { fair, deployer, signers, proofs };
  }

  it("allows a valid claim and blocks double-claims", async function () {
    const { fair, signers, proofs } = await deployFixture();

    const user = signers[0];
    const proof = proofs[user.address.toLowerCase()];

    await expect(fair.connect(user).claim(proof))
      .to.emit(fair, "Claimed")
      .withArgs(user.address, 95n * WAD, 5n * WAD);

    expect(await fair.balanceOf(user.address)).to.equal(95n * WAD);
    expect(await fair.balanceOf(await fair.getAddress())).to.equal(5n * WAD);
    expect(await fair.totalSupply()).to.equal(100n * WAD);
    expect(await fair.claimed(user.address)).to.equal(true);

    await expect(fair.connect(user).claim(proofs[user.address.toLowerCase()])).to.be.revertedWith("ALREADY_CLAIMED");
  });

  it("rejects an invalid proof", async function () {
    const { fair, signers, proofs } = await deployFixture();
    const user = signers[1];
    // Give the wrong proof (from a different address)
    const wrongProof = proofs[signers[2].address.toLowerCase()];
    await expect(fair.connect(user).claim(wrongProof)).to.be.revertedWith("INVALID_PROOF");
  });

  it("simulates a buy with zero fee and updates reserves", async function () {
    const { fair, signers, proofs } = await deployFixture();
    const donor = signers[0];
    const buyer = signers[1];

    // Donor claims and seeds liquidity with FAIR + ETH
    await fair.connect(donor).claim(proofs[donor.address.toLowerCase()]);
    const donateFair = 50n * WAD;
    const donateEth = 1n * WAD;
    await fair.connect(donor).donate(donateFair, { value: donateEth });

    const reserveFairBefore = await fair.reserveFair();
    const reserveEthBefore = await fair.reserveEth();

    const ethIn = 1n * WAD;
    const expectedFairOut = amountOutConstantProduct(ethIn, reserveEthBefore, reserveFairBefore);

    await expect(fair.connect(buyer).buyFair({ value: ethIn }))
      .to.emit(fair, "Buy")
      .withArgs(buyer.address, ethIn, expectedFairOut);

    const buyerBalance = await fair.balanceOf(buyer.address);
    expect(buyerBalance).to.equal(expectedFairOut);

    const reserveFairAfter = await fair.reserveFair();
    const reserveEthAfter = await fair.reserveEth();

    expect(reserveEthAfter).to.equal(reserveEthBefore + ethIn);
    expect(reserveFairAfter).to.equal(reserveFairBefore - expectedFairOut);
  });

  it("applies 0.1% fee on sells and routes it to founder", async function () {
    const { fair, deployer, signers, proofs } = await deployFixture();
    const liquidityProvider = signers[0];
    const seller = signers[1];

    // LP seeds pool
    await fair.connect(liquidityProvider).claim(proofs[liquidityProvider.address.toLowerCase()]);
    await fair.connect(liquidityProvider).donate(50n * WAD, { value: 2n * WAD });

    // Seller claims to get FAIR to sell
    await fair.connect(seller).claim(proofs[seller.address.toLowerCase()]);

    const sellAmount = 10n * WAD;
    const fee = sellAmount / 1000n; // 0.1%
    const amountAfterFee = sellAmount - fee;

    const reserveFairBefore = await fair.reserveFair();
    const reserveEthBefore = await fair.reserveEth();

    const expectedEthOut = amountOutConstantProduct(amountAfterFee, reserveFairBefore, reserveEthBefore);

    const txPromise = fair.connect(seller).sellFair(sellAmount);
    await expect(txPromise)
      .to.emit(fair, "Sell")
      .withArgs(seller.address, sellAmount, fee, expectedEthOut);

    const tx = await txPromise;
    await tx.wait();

    const founderBalance = await fair.balanceOf(deployer.address);
    expect(founderBalance).to.equal(fee);

    expect(await fair.reserveFair()).to.equal(reserveFairBefore + amountAfterFee);
    expect(await fair.reserveEth()).to.equal(reserveEthBefore - expectedEthOut);
  });
});
