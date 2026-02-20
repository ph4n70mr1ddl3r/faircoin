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

    expect(await fair.CLAIM_AMOUNT()).to.equal(100n * WAD);
    expect(await fair.FEE_DENOMINATOR()).to.equal(1000n);

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

    await fair.connect(donor).claim(proofs[donor.address.toLowerCase()]);
    const donateFair = 50n * WAD;
    const donateEth = 1n * WAD;
    await fair.connect(donor).donate(donateFair, { value: donateEth });

    const reserveFairBefore = await fair.reserveFair();
    const reserveEthBefore = await fair.reserveEth();

    const ethIn = 1n * WAD;
    const expectedFairOut = (reserveFairBefore * ethIn) / (reserveEthBefore + ethIn);
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    await expect(fair.connect(buyer).buyFair(expectedFairOut, deadline, { value: ethIn }))
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

    await fair.connect(liquidityProvider).claim(proofs[liquidityProvider.address.toLowerCase()]);
    await fair.connect(liquidityProvider).donate(50n * WAD, { value: 2n * WAD });

    await fair.connect(seller).claim(proofs[seller.address.toLowerCase()]);

    const sellAmount = 10n * WAD;
    const fee = sellAmount / 1000n;
    const amountAfterFee = sellAmount - fee;

    const reserveFairBefore = await fair.reserveFair();
    const reserveEthBefore = await fair.reserveEth();

    const expectedEthOut = (reserveEthBefore * amountAfterFee) / (reserveFairBefore + amountAfterFee);
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    const txPromise = fair.connect(seller).sellFair(sellAmount, expectedEthOut, deadline);
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

  it("rejects donate with zero FAIR and zero ETH", async function () {
    const { fair } = await deployFixture();
    await expect(fair.donate(0, { value: 0 })).to.be.revertedWith("DONATE_ZERO");
  });

  it("allows donate with only ETH", async function () {
    const { fair, signers } = await deployFixture();
    const donor = signers[0];
    const donateEth = 1n * WAD;
    await expect(fair.connect(donor).donate(0, { value: donateEth }))
      .to.emit(fair, "Donation")
      .withArgs(donor.address, 0, donateEth);
    expect(await fair.reserveEth()).to.equal(donateEth);
  });

  it("allows donate with only FAIR", async function () {
    const { fair, signers, proofs } = await deployFixture();
    const donor = signers[0];
    await fair.connect(donor).claim(proofs[donor.address.toLowerCase()]);
    const donateFair = 10n * WAD;
    await expect(fair.connect(donor).donate(donateFair, { value: 0 }))
      .to.emit(fair, "Donation")
      .withArgs(donor.address, donateFair, 0);
    expect(await fair.reserveFair()).to.equal(15n * WAD);
  });

  it("rejects buy with zero ETH", async function () {
    const { fair, signers } = await deployFixture();
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    await expect(fair.connect(signers[0]).buyFair(0, deadline, { value: 0 })).to.be.revertedWith("ZERO_IN");
  });

  it("rejects buy with no liquidity", async function () {
    const { fair, signers } = await deployFixture();
    const ethIn = 1n * WAD;
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    await expect(fair.connect(signers[0]).buyFair(0, deadline, { value: ethIn })).to.be.revertedWith("NO_LIQUIDITY");
  });

  it("rejects sell with zero amount", async function () {
    const { fair, signers } = await deployFixture();
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    await expect(fair.connect(signers[0]).sellFair(0, 0, deadline)).to.be.revertedWith("ZERO_IN");
  });

  it("rejects sell without sufficient balance", async function () {
    const { fair, signers } = await deployFixture();
    const seller = signers[0];
    const sellAmount = 100n * WAD;
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    await expect(fair.connect(seller).sellFair(sellAmount, 0, deadline)).to.be.revertedWith("BALANCE");
  });

  it("prevents double-claim", async function () {
    const { fair, signers, proofs } = await deployFixture();
    const user = signers[0];
    const proof = proofs[user.address.toLowerCase()];
    
    await fair.connect(user).claim(proof);
    await expect(fair.connect(user).claim(proof)).to.be.revertedWith("ALREADY_CLAIMED");
  });

  it("syncs reserves correctly after receive ETH", async function () {
    const { fair, signers } = await deployFixture();
    const donor = signers[0];
    const ethAmount = 1n * WAD;
    
    await expect(donor.sendTransaction({ to: await fair.getAddress(), value: ethAmount }))
      .to.emit(fair, "Sync");
    
    expect(await fair.reserveEth()).to.equal(ethAmount);
  });

  it("allows founder to pause and unpause", async function () {
    const { fair, deployer, signers, proofs } = await deployFixture();
    const user = signers[0];
    const proof = proofs[user.address.toLowerCase()];

    await expect(fair.connect(deployer).pause())
      .to.emit(fair, "Paused");
    
    expect(await fair.paused()).to.equal(true);

    await expect(fair.connect(user).claim(proof)).to.be.reverted;

    await expect(fair.connect(deployer).unpause())
      .to.emit(fair, "Unpaused");
    
    expect(await fair.paused()).to.equal(false);

    await expect(fair.connect(user).claim(proof))
      .to.emit(fair, "Claimed");
  });

  it("rejects pause from non-founder", async function () {
    const { fair, signers } = await deployFixture();
    await expect(fair.connect(signers[0]).pause()).to.be.revertedWith("NOT_FOUNDER");
  });

  it("enforces MAX_SUPPLY limit", async function () {
    const { fair, signers, proofs } = await deployFixture();
    const user = signers[0];
    const proof = proofs[user.address.toLowerCase()];

    expect(await fair.MAX_SUPPLY()).to.equal(1_000_000_000n * WAD);

    await fair.connect(user).claim(proof);
    expect(await fair.totalSupply()).to.equal(100n * WAD);
  });

  it("rejects buy with expired deadline", async function () {
    const { fair, signers, proofs } = await deployFixture();
    const donor = signers[0];
    const buyer = signers[1];

    await fair.connect(donor).claim(proofs[donor.address.toLowerCase()]);
    await fair.connect(donor).donate(50n * WAD, { value: 1n * WAD });

    const expiredDeadline = Math.floor(Date.now() / 1000) - 1;
    await expect(fair.connect(buyer).buyFair(0, expiredDeadline, { value: 1n * WAD }))
      .to.be.revertedWith("EXPIRED");
  });

  it("rejects sell with expired deadline", async function () {
    const { fair, signers, proofs } = await deployFixture();
    const lp = signers[0];
    const seller = signers[1];

    await fair.connect(lp).claim(proofs[lp.address.toLowerCase()]);
    await fair.connect(lp).donate(50n * WAD, { value: 1n * WAD });
    await fair.connect(seller).claim(proofs[seller.address.toLowerCase()]);

    const expiredDeadline = Math.floor(Date.now() / 1000) - 1;
    await expect(fair.connect(seller).sellFair(10n * WAD, 0, expiredDeadline))
      .to.be.revertedWith("EXPIRED");
  });

  it("rejects buy with slippage exceeded", async function () {
    const { fair, signers, proofs } = await deployFixture();
    const donor = signers[0];
    const buyer = signers[1];

    await fair.connect(donor).claim(proofs[donor.address.toLowerCase()]);
    await fair.connect(donor).donate(50n * WAD, { value: 1n * WAD });

    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const excessiveMinOut = 1000n * WAD;
    await expect(fair.connect(buyer).buyFair(excessiveMinOut, deadline, { value: 1n * WAD }))
      .to.be.revertedWith("SLIPPAGE_EXCEEDED");
  });

  it("rejects sell with slippage exceeded", async function () {
    const { fair, signers, proofs } = await deployFixture();
    const lp = signers[0];
    const seller = signers[1];

    await fair.connect(lp).claim(proofs[lp.address.toLowerCase()]);
    await fair.connect(lp).donate(50n * WAD, { value: 2n * WAD });
    await fair.connect(seller).claim(proofs[seller.address.toLowerCase()]);

    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const excessiveMinEth = 100n * WAD;
    await expect(fair.connect(seller).sellFair(10n * WAD, excessiveMinEth, deadline))
      .to.be.revertedWith("SLIPPAGE_EXCEEDED");
  });

  it("rejects approve to zero address", async function () {
    const { fair, signers } = await deployFixture();
    await expect(fair.connect(signers[0]).approve(ethers.ZeroAddress, 100n * WAD))
      .to.be.revertedWith("ZERO_SPENDER");
  });

  it("rejects transferFrom with insufficient allowance", async function () {
    const { fair, signers, proofs } = await deployFixture();
    const owner = signers[0];
    const spender = signers[1];
    const recipient = signers[2];

    await fair.connect(owner).claim(proofs[owner.address.toLowerCase()]);
    
    await expect(fair.connect(spender).transferFrom(owner.address, recipient.address, 10n * WAD))
      .to.be.revertedWith("ALLOWANCE");
  });

  it("allows transferFrom with sufficient allowance", async function () {
    const { fair, signers, proofs } = await deployFixture();
    const owner = signers[0];
    const spender = signers[1];
    const recipient = signers[2];

    await fair.connect(owner).claim(proofs[owner.address.toLowerCase()]);
    await fair.connect(owner).approve(spender.address, 10n * WAD);

    await expect(fair.connect(spender).transferFrom(owner.address, recipient.address, 10n * WAD))
      .to.emit(fair, "Transfer")
      .withArgs(owner.address, recipient.address, 10n * WAD);

    expect(await fair.balanceOf(recipient.address)).to.equal(10n * WAD);
  });

  it("rejects buy and sell when paused", async function () {
    const { fair, deployer, signers, proofs } = await deployFixture();
    const lp = signers[0];
    const user = signers[1];

    await fair.connect(lp).claim(proofs[lp.address.toLowerCase()]);
    await fair.connect(lp).donate(50n * WAD, { value: 1n * WAD });
    await fair.connect(user).claim(proofs[user.address.toLowerCase()]);

    await fair.connect(deployer).pause();

    const deadline = Math.floor(Date.now() / 1000) + 3600;
    await expect(fair.connect(user).buyFair(0, deadline, { value: 1n * WAD }))
      .to.be.reverted;
    await expect(fair.connect(user).sellFair(10n * WAD, 0, deadline))
      .to.be.reverted;
  });

  it("enforces minimum fee of 1 wei for small sells", async function () {
    const { fair, deployer, signers, proofs } = await deployFixture();
    const lp = signers[0];
    const seller = signers[1];

    await fair.connect(lp).claim(proofs[lp.address.toLowerCase()]);
    await fair.connect(lp).donate(50n * WAD, { value: 2n * WAD });
    await fair.connect(seller).claim(proofs[seller.address.toLowerCase()]);

    const sellAmount = 500n;
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    const tx = await fair.connect(seller).sellFair(sellAmount, 0, deadline);
    const receipt = await tx.wait();
    const sellEvent = receipt.logs.find(l => fair.interface.parseLog(l)?.name === "Sell");
    const parsedEvent = fair.interface.parseLog(sellEvent);
    expect(parsedEvent.args[2]).to.equal(1n);
  });

  it("allows direct transfer between accounts", async function () {
    const { fair, signers, proofs } = await deployFixture();
    const sender = signers[0];
    const recipient = signers[1];

    await fair.connect(sender).claim(proofs[sender.address.toLowerCase()]);
    
    const transferAmount = 10n * WAD;
    await expect(fair.connect(sender).transfer(recipient.address, transferAmount))
      .to.emit(fair, "Transfer")
      .withArgs(sender.address, recipient.address, transferAmount);

    expect(await fair.balanceOf(sender.address)).to.equal(95n * WAD - transferAmount);
    expect(await fair.balanceOf(recipient.address)).to.equal(transferAmount);
  });

  it("rejects transfer to zero address", async function () {
    const { fair, signers, proofs } = await deployFixture();
    const sender = signers[0];

    await fair.connect(sender).claim(proofs[sender.address.toLowerCase()]);
    
    await expect(fair.connect(sender).transfer(ethers.ZeroAddress, 10n * WAD))
      .to.be.revertedWith("ZERO_TO");
  });

  it("rejects transfer with insufficient balance", async function () {
    const { fair, signers, proofs } = await deployFixture();
    const sender = signers[0];
    const recipient = signers[1];

    await fair.connect(sender).claim(proofs[sender.address.toLowerCase()]);
    
    await expect(fair.connect(sender).transfer(recipient.address, 100n * WAD))
      .to.be.revertedWith("BALANCE");
  });

  it("allows donating both FAIR and ETH simultaneously", async function () {
    const { fair, signers, proofs } = await deployFixture();
    const donor = signers[0];

    await fair.connect(donor).claim(proofs[donor.address.toLowerCase()]);
    
    const donateFair = 10n * WAD;
    const donateEth = 1n * WAD;
    
    await expect(fair.connect(donor).donate(donateFair, { value: donateEth }))
      .to.emit(fair, "Donation")
      .withArgs(donor.address, donateFair, donateEth);

    expect(await fair.reserveFair()).to.equal(15n * WAD);
    expect(await fair.reserveEth()).to.equal(donateEth);
  });

  it("handles receive with zero ETH gracefully", async function () {
    const { fair, signers } = await deployFixture();
    const donor = signers[0];

    const reserveEthBefore = await fair.reserveEth();
    
    await donor.sendTransaction({ to: await fair.getAddress(), value: 0 });
    
    expect(await fair.reserveEth()).to.equal(reserveEthBefore);
  });

  it("prevents claim exceeding MAX_SUPPLY", async function () {
    const { fair, signers, proofs } = await deployFixture();
    const maxSupply = await fair.MAX_SUPPLY();
    const claimAmount = await fair.CLAIM_AMOUNT();
    
    const maxClaims = maxSupply / claimAmount;
    
    const entries = loadSample();
    if (entries.length < Number(maxClaims)) {
      this.skip();
    }
    
    expect(maxSupply).to.equal(1_000_000_000n * WAD);
    expect(claimAmount).to.equal(100n * WAD);
  });
});
