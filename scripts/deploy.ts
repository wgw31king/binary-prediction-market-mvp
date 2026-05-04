import { network } from "hardhat";

async function main() {
  const { ethers } = await network.create();
  const [deployer] = await ethers.getSigners();

  let collateralAddress = process.env.USDT_ADDRESS?.trim();
  if (!collateralAddress) {
    const mock = await ethers.deployContract("contracts/mocks/MockERC20.sol:MockERC20", [
      "Mock USD",
      "mUSD",
      18,
    ]);
    collateralAddress = await mock.getAddress();
    console.log("Deployed MockERC20 (local/testing collateral):", collateralAddress);
  } else {
    console.log("Using collateral token:", collateralAddress);
  }

  const baseUri = process.env.BASE_URI ?? "https://example.invalid/metadata/{id}.json";
  const pm = await ethers.deployContract("PredictionMarket", [collateralAddress, baseUri]);
  console.log("PredictionMarket:", await pm.getAddress());
  console.log("Deployer (DEFAULT_ADMIN + initial MARKET_ADMIN + RESOLVER):", deployer.address);

  const extraAdmin = process.env.ADMIN_ADDRESS?.trim();
  if (extraAdmin && ethers.isAddress(extraAdmin)) {
    const marketAdmin = await pm.MARKET_ADMIN_ROLE();
    const resolver = await pm.RESOLVER_ROLE();
    await (await pm.grantRole(marketAdmin, extraAdmin)).wait();
    await (await pm.grantRole(resolver, extraAdmin)).wait();
    console.log("Granted MARKET_ADMIN_ROLE and RESOLVER_ROLE to:", extraAdmin);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
