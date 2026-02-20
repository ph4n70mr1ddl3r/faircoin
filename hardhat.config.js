require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  networks: {
    hardhat: {
      chainId: 31337
    }
    // Add production networks via environment variables only:
    // mainnet: { url: process.env.MAINNET_RPC, accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [] }
  }
};
