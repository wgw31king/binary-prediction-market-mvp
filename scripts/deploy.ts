import { network } from "hardhat";

function parseAddressList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

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

  const escrowImpl = await ethers.deployContract("CollateralEscrow");
  const escrowImplAddr = await escrowImpl.getAddress();
  console.log("CollateralEscrow implementation:", escrowImplAddr);

  const baseUri = process.env.BASE_URI ?? "https://example.invalid/metadata/{id}.json";
  const pm = await ethers.deployContract("PredictionMarket", [collateralAddress, baseUri, escrowImplAddr]);
  const pmAddr = await pm.getAddress();
  console.log("PredictionMarket:", pmAddr);
  console.log("Deployer (initial DEFAULT_ADMIN + MARKET_ADMIN + PAUSER):", deployer.address);

  const signerCandidates = parseAddressList(process.env.RESOLUTION_SIGNERS).filter((a) => ethers.isAddress(a));
  const resolutionSigners = signerCandidates.length > 0 ? signerCandidates : [deployer.address];

  let threshold = Number.parseInt(process.env.RESOLUTION_THRESHOLD ?? "", 10);
  if (!Number.isFinite(threshold) || threshold < 1) {
    threshold = resolutionSigners.length >= 2 ? 2 : 1;
  }
  if (threshold > resolutionSigners.length) {
    throw new Error(`RESOLUTION_THRESHOLD (${threshold}) exceeds RESOLUTION_SIGNERS count (${resolutionSigners.length})`);
  }

  await (await pm.setResolutionConfig(resolutionSigners, threshold)).wait();
  console.log("Resolution config:", { threshold, signerCount: resolutionSigners.length });

  const extraAdmin = process.env.ADMIN_ADDRESS?.trim();
  if (extraAdmin && ethers.isAddress(extraAdmin)) {
    const marketAdmin = await pm.MARKET_ADMIN_ROLE();
    const pauser = await pm.PAUSER_ROLE();
    await (await pm.grantRole(marketAdmin, extraAdmin)).wait();
    await (await pm.grantRole(pauser, extraAdmin)).wait();
    console.log("Granted MARKET_ADMIN_ROLE and PAUSER_ROLE to:", extraAdmin);
  }

  const useTimelock = process.env.DEPLOY_WITH_TIMELOCK === "true";
  if (useTimelock) {
    const minDelay = BigInt(process.env.TIMELOCK_MIN_DELAY_SECONDS ?? "86400");
    const proposers = parseAddressList(process.env.TIMELOCK_PROPOSERS).filter((a) => ethers.isAddress(a));
    const executorsList = parseAddressList(process.env.TIMELOCK_EXECUTORS).filter((a) => ethers.isAddress(a));
    const executors = executorsList.length > 0 ? executorsList : proposers;
    if (proposers.length === 0) {
      throw new Error("DEPLOY_WITH_TIMELOCK requires TIMELOCK_PROPOSERS (comma-separated addresses)");
    }
    if (executors.length === 0) {
      throw new Error("Timelock executors empty; set TIMELOCK_EXECUTORS or reuse proposers");
    }

    const timelock = await ethers.deployContract("TimelockControllerImport", [
      minDelay,
      proposers,
      executors,
      deployer.address,
    ]);
    const timelockAddr = await timelock.getAddress();
    console.log("TimelockController:", timelockAddr, "minDelay:", minDelay.toString());

    const adminRole = await pm.DEFAULT_ADMIN_ROLE();
    await (await pm.grantRole(adminRole, timelockAddr)).wait();
    await (await pm.revokeRole(adminRole, deployer.address)).wait();
    console.log("PredictionMarket DEFAULT_ADMIN_ROLE is now TimelockController (deployer revoked).");
    console.log(
      "Next steps: grant/revoke roles and update resolution signers via Timelock.schedule on PredictionMarket.",
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
