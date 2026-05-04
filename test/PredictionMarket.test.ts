import { expect } from "chai";
import { MaxUint256, parseEther, Wallet, ZeroAddress } from "ethers";
import { network } from "hardhat";
import { collectResolutionSignatures, signResolution } from "./helpers/eip712";

const OUTCOME_YES = 1;
const OUTCOME_NO = 2;

describe("PredictionMarket", function () {
  async function deployFixture() {
    const { ethers: eh, networkHelpers } = await network.create();
    const [deployer, marketGuy, pauserGuy, alice, bob, stranger, sig1, sig2, sig3] = await eh.getSigners();

    const token = await eh.deployContract("contracts/mocks/MockERC20.sol:MockERC20", [
      "Mock USD",
      "mUSD",
      18,
    ]);
    const tokenAddr = await token.getAddress();

    const escrowImpl = await eh.deployContract("CollateralEscrow");
    const escrowImplAddr = await escrowImpl.getAddress();

    const pm = await eh.deployContract("PredictionMarket", [
      tokenAddr,
      "https://example.invalid/{id}.json",
      escrowImplAddr,
    ]);

    const MARKET_ADMIN_ROLE = await pm.MARKET_ADMIN_ROLE();
    const PAUSER_ROLE = await pm.PAUSER_ROLE();
    const DEFAULT_ADMIN_ROLE = await pm.DEFAULT_ADMIN_ROLE();

    await pm.connect(deployer).grantRole(MARKET_ADMIN_ROLE, marketGuy.address);
    await pm.connect(deployer).revokeRole(MARKET_ADMIN_ROLE, deployer.address);

    await pm.connect(deployer).grantRole(PAUSER_ROLE, pauserGuy.address);
    await pm.connect(deployer).revokeRole(PAUSER_ROLE, deployer.address);

    await pm.connect(deployer).setResolutionConfig([sig1.address, sig2.address, sig3.address], 2);

    const fund = async (to: string, amount: bigint) => {
      await token.mint(to, amount);
    };

    async function resolveWithSigs(
      marketId: bigint,
      outcome: number,
      signers: typeof sig1[],
      deadline?: bigint,
    ) {
      const nonce = await pm.resolutionNonces(marketId);
      const dl =
        deadline ?? BigInt(await networkHelpers.time.latest()) + 3600n;
      const value = { marketId, outcome: BigInt(outcome), deadline: dl, nonce };
      const signatures = await collectResolutionSignatures(signers, pm, value);
      return pm.resolveWithSignatures(marketId, outcome, dl, signatures);
    }

    return {
      ethers: eh,
      networkHelpers,
      deployer,
      marketGuy,
      pauserGuy,
      alice,
      bob,
      stranger,
      sig1,
      sig2,
      sig3,
      token,
      pm,
      MARKET_ADMIN_ROLE,
      PAUSER_ROLE,
      DEFAULT_ADMIN_ROLE,
      fund,
      resolveWithSigs,
    };
  }

  it("creates a market, deploys per-market escrow, and emits MarketCreated", async function () {
    const { pm, marketGuy, networkHelpers } = await deployFixture();
    const end = BigInt(await networkHelpers.time.latest()) + 10_000n;
    await expect(pm.connect(marketGuy).createMarket("ipfs://q", Number(end))).to.emit(pm, "MarketCreated");
    expect(await pm.marketCount()).to.equal(1n);
    expect(await pm.marketEscrow(0n)).to.not.equal(ZeroAddress);
  });

  it("rejects createMarket from address without MARKET_ADMIN_ROLE", async function () {
    const { pm, stranger, networkHelpers } = await deployFixture();
    const end = BigInt(await networkHelpers.time.latest()) + 100n;
    await expect(pm.connect(stranger).createMarket("x", Number(end))).to.be.revertedWithCustomError(
      pm,
      "AccessControlUnauthorizedAccount",
    );
  });

  it("buyShares mints ERC1155 1:1 and moves collateral into the market escrow", async function () {
    const { pm, token, marketGuy, alice, fund, networkHelpers } = await deployFixture();
    const end = BigInt(await networkHelpers.time.latest()) + 10_000n;
    await pm.connect(marketGuy).createMarket("m", Number(end));

    const amt = parseEther("100");
    await fund(alice.address, amt);
    await token.connect(alice).approve(await pm.getAddress(), amt);

    await expect(pm.connect(alice).buyShares(0, true, amt))
      .to.emit(pm, "SharesPurchased")
      .withArgs(0n, alice.address, true, amt);

    const escrow = await pm.marketEscrow(0n);
    const yesId = await pm.packTokenId(0n, true);
    expect(await pm.balanceOf(alice.address, yesId)).to.equal(amt);
    expect(await token.balanceOf(alice.address)).to.equal(0n);
    expect(await token.balanceOf(escrow)).to.equal(amt);
    expect(await token.balanceOf(await pm.getAddress())).to.equal(0n);

    const m = await pm.markets(0n);
    expect(m.collateral).to.equal(amt);
    expect(m.yesShares).to.equal(amt);
    expect(m.noShares).to.equal(0n);
  });

  it("reverts buyShares after endTime", async function () {
    const { pm, token, marketGuy, alice, fund, networkHelpers } = await deployFixture();
    const end = BigInt(await networkHelpers.time.latest()) + 100n;
    await pm.connect(marketGuy).createMarket("m", Number(end));

    await networkHelpers.time.increaseTo(end + 1n);

    const amt = parseEther("1");
    await fund(alice.address, amt);
    await token.connect(alice).approve(await pm.getAddress(), amt);

    await expect(pm.connect(alice).buyShares(0, true, amt)).to.be.revertedWithCustomError(
      pm,
      "PredictionMarket__TradingClosed",
    );
  });

  it("resolves after deadline via EIP-712 multisig and pays parimutuel winners", async function () {
    const { pm, token, marketGuy, alice, bob, fund, networkHelpers, sig1, sig2, resolveWithSigs } =
      await deployFixture();
    const end = BigInt(await networkHelpers.time.latest()) + 1000n;
    await pm.connect(marketGuy).createMarket("m", Number(end));

    const aYes = parseEther("100");
    const bNo = parseEther("50");
    await fund(alice.address, aYes);
    await fund(bob.address, bNo);
    await token.connect(alice).approve(await pm.getAddress(), aYes);
    await token.connect(bob).approve(await pm.getAddress(), bNo);
    await pm.connect(alice).buyShares(0, true, aYes);
    await pm.connect(bob).buyShares(0, false, bNo);

    await networkHelpers.time.increaseTo(end + 1n);

    const resDeadline = BigInt(await networkHelpers.time.latest()) + 7200n;
    await expect(resolveWithSigs(0n, OUTCOME_YES, [sig1, sig2], resDeadline))
      .to.emit(pm, "MarketResolved")
      .withArgs(0n, OUTCOME_YES, await pm.RESOLVER_KIND_MULTISIG_EIP712(), 0n, resDeadline);

    const before = await token.balanceOf(alice.address);
    const yesId = await pm.packTokenId(0n, true);
    const escrow = await pm.marketEscrow(0n);
    await expect(pm.connect(alice).claim(0, aYes))
      .to.emit(pm, "PayoutClaimed")
      .withArgs(0n, alice.address, aYes, aYes + bNo);
    expect(await token.balanceOf(alice.address)).to.equal(before + aYes + bNo);

    expect(await pm.balanceOf(alice.address, yesId)).to.equal(0n);
    expect(await token.balanceOf(escrow)).to.equal(0n);
  });

  it("distributes partial claims proportionally", async function () {
    const { pm, token, marketGuy, alice, bob, fund, networkHelpers, sig1, sig2, resolveWithSigs } =
      await deployFixture();
    const end = BigInt(await networkHelpers.time.latest()) + 500n;
    await pm.connect(marketGuy).createMarket("m", Number(end));

    const aAmt = parseEther("100");
    const bAmt = parseEther("50");
    await fund(alice.address, aAmt);
    await fund(bob.address, bAmt);
    await token.connect(alice).approve(await pm.getAddress(), aAmt);
    await token.connect(bob).approve(await pm.getAddress(), bAmt);
    await pm.connect(alice).buyShares(0, true, aAmt);
    await pm.connect(bob).buyShares(0, true, bAmt);

    await networkHelpers.time.increaseTo(end + 1n);
    await resolveWithSigs(0n, OUTCOME_YES, [sig1, sig2]);

    const half = parseEther("50");
    await pm.connect(alice).claim(0, half);
    await pm.connect(bob).claim(0, bAmt);
    await pm.connect(alice).claimAll(0);

    expect(await token.balanceOf(await pm.marketEscrow(0n))).to.equal(0n);
  });

  it("reverts resolve if winning side has zero shares", async function () {
    const { pm, token, marketGuy, alice, fund, networkHelpers, sig1, sig2, resolveWithSigs } =
      await deployFixture();
    const end = BigInt(await networkHelpers.time.latest()) + 200n;
    await pm.connect(marketGuy).createMarket("m", Number(end));

    await fund(alice.address, parseEther("10"));
    await token.connect(alice).approve(await pm.getAddress(), MaxUint256);
    await pm.connect(alice).buyShares(0, false, parseEther("10"));

    await networkHelpers.time.increaseTo(end + 1n);

    await expect(resolveWithSigs(0n, OUTCOME_YES, [sig1, sig2])).to.be.revertedWithCustomError(
      pm,
      "PredictionMarket__WinningSideEmpty",
    );
  });

  it("reverts resolve before trading deadline", async function () {
    const { pm, marketGuy, networkHelpers, sig1, sig2, resolveWithSigs } = await deployFixture();
    const end = BigInt(await networkHelpers.time.latest()) + 10_000n;
    await pm.connect(marketGuy).createMarket("m", Number(end));

    await expect(resolveWithSigs(0n, OUTCOME_YES, [sig1, sig2])).to.be.revertedWithCustomError(
      pm,
      "PredictionMarket__ResolutionBeforeDeadline",
    );
  });

  it("reverts when signature deadline has passed", async function () {
    const { pm, marketGuy, networkHelpers, sig1, sig2 } = await deployFixture();
    const end = BigInt(await networkHelpers.time.latest()) + 50n;
    await pm.connect(marketGuy).createMarket("m", Number(end));
    await networkHelpers.time.increaseTo(end + 1n);

    const nonce = await pm.resolutionNonces(0n);
    const deadline = BigInt(await networkHelpers.time.latest()) - 1n;
    const value = { marketId: 0n, outcome: 1n, deadline, nonce };
    const signatures = await collectResolutionSignatures([sig1, sig2], pm, value);

    await expect(pm.resolveWithSignatures(0, OUTCOME_YES, deadline, signatures)).to.be.revertedWithCustomError(
      pm,
      "PredictionMarket__ResolutionPastSignatureDeadline",
    );
  });

  it("reverts when not enough valid signer signatures", async function () {
    const { pm, marketGuy, networkHelpers, sig1 } = await deployFixture();
    const end = BigInt(await networkHelpers.time.latest()) + 80n;
    await pm.connect(marketGuy).createMarket("m", Number(end));
    await networkHelpers.time.increaseTo(end + 1n);

    const nonce = await pm.resolutionNonces(0n);
    const deadline = BigInt(await networkHelpers.time.latest()) + 3600n;
    const value = { marketId: 0n, outcome: 1n, deadline, nonce };
    const signatures = await collectResolutionSignatures([sig1], pm, value);

    await expect(pm.resolveWithSignatures(0, OUTCOME_YES, deadline, signatures)).to.be.revertedWithCustomError(
      pm,
      "PredictionMarket__InsufficientResolutionSignatures",
    );
  });

  it("reverts resolve when resolution oracle is not configured", async function () {
    const { ethers: eh, networkHelpers } = await network.create();
    const [deployer, marketGuy, sig1, sig2] = await eh.getSigners();
    const token = await eh.deployContract("contracts/mocks/MockERC20.sol:MockERC20", ["M", "M", 18]);
    const escrowImpl = await eh.deployContract("CollateralEscrow");
    const pm = await eh.deployContract("PredictionMarket", [
      await token.getAddress(),
      "",
      await escrowImpl.getAddress(),
    ]);
    await pm.connect(deployer).grantRole(await pm.MARKET_ADMIN_ROLE(), marketGuy.address);
    await pm.connect(deployer).revokeRole(await pm.MARKET_ADMIN_ROLE(), deployer.address);

    const end = BigInt(await networkHelpers.time.latest()) + 100n;
    await pm.connect(marketGuy).createMarket("m", Number(end));
    await networkHelpers.time.increaseTo(end + 1n);

    const nonce = await pm.resolutionNonces(0n);
    const deadline = BigInt(await networkHelpers.time.latest()) + 3600n;
    const value = { marketId: 0n, outcome: 1n, deadline, nonce };
    const signatures = await collectResolutionSignatures([sig1, sig2], pm, value);

    await expect(pm.resolveWithSignatures(0, OUTCOME_YES, deadline, signatures)).to.be.revertedWithCustomError(
      pm,
      "PredictionMarket__ResolutionNotConfigured",
    );
  });

  it("rejects stale nonce (replay)", async function () {
    const { pm, token, marketGuy, alice, fund, networkHelpers, sig1, sig2 } = await deployFixture();
    const end = BigInt(await networkHelpers.time.latest()) + 200n;
    await pm.connect(marketGuy).createMarket("m", Number(end));
    const amt = parseEther("10");
    await fund(alice.address, amt);
    await token.connect(alice).approve(await pm.getAddress(), amt);
    await pm.connect(alice).buyShares(0, true, amt);
    await networkHelpers.time.increaseTo(end + 1n);

    const deadline = BigInt(await networkHelpers.time.latest()) + 3600n;
    const nonce0 = await pm.resolutionNonces(0n);
    const sigsA = await collectResolutionSignatures([sig1, sig2], pm, {
      marketId: 0n,
      outcome: 1n,
      deadline,
      nonce: nonce0,
    });
    await pm.resolveWithSignatures(0, OUTCOME_YES, deadline, sigsA);

    const sigsB = await collectResolutionSignatures([sig1, sig2], pm, {
      marketId: 0n,
      outcome: 1n,
      deadline,
      nonce: nonce0,
    });
    await expect(pm.resolveWithSignatures(0, OUTCOME_YES, deadline, sigsB)).to.be.revertedWithCustomError(
      pm,
      "PredictionMarket__NotOpen",
    );
  });

  it("blocks peer-to-peer ERC1155 transfers", async function () {
    const { pm, token, marketGuy, alice, bob, fund, networkHelpers } = await deployFixture();
    const end = BigInt(await networkHelpers.time.latest()) + 5000n;
    await pm.connect(marketGuy).createMarket("m", Number(end));

    const amt = parseEther("10");
    await fund(alice.address, amt);
    await token.connect(alice).approve(await pm.getAddress(), amt);
    await pm.connect(alice).buyShares(0, true, amt);

    const yesId = await pm.packTokenId(0n, true);
    await pm.connect(alice).setApprovalForAll(bob.address, true);

    await expect(
      pm.connect(alice).safeTransferFrom(alice.address, bob.address, yesId, amt, "0x"),
    ).to.be.revertedWithCustomError(pm, "PredictionMarket__TransfersDisabled");
  });

  it("cancelMarket allows 1:1 refunds from escrow", async function () {
    const { pm, token, marketGuy, alice, fund, networkHelpers } = await deployFixture();
    const end = BigInt(await networkHelpers.time.latest()) + 9000n;
    await pm.connect(marketGuy).createMarket("m", Number(end));

    const amt = parseEther("40");
    await fund(alice.address, amt);
    await token.connect(alice).approve(await pm.getAddress(), amt);
    await pm.connect(alice).buyShares(0, true, amt);

    await pm.connect(marketGuy).cancelMarket(0);

    const before = await token.balanceOf(alice.address);
    await pm.connect(alice).refundCancelled(0, true, amt);
    expect(await token.balanceOf(alice.address)).to.equal(before + amt);
  });

  it("pauses user flows and unpause restores", async function () {
    const { pm, token, marketGuy, pauserGuy, alice, fund, networkHelpers, sig1, sig2, resolveWithSigs } =
      await deployFixture();
    const end = BigInt(await networkHelpers.time.latest()) + 800n;
    await pm.connect(marketGuy).createMarket("m", Number(end));

    const amt = parseEther("5");
    await fund(alice.address, amt * 3n);
    await token.connect(alice).approve(await pm.getAddress(), amt * 3n);

    await pm.connect(pauserGuy).pause();

    await expect(pm.connect(alice).buyShares(0, true, amt)).to.be.revertedWithCustomError(pm, "EnforcedPause");

    await pm.connect(pauserGuy).unpause();
    await pm.connect(alice).buyShares(0, true, amt);

    await networkHelpers.time.increaseTo(end + 1n);
    await resolveWithSigs(0n, OUTCOME_YES, [sig1, sig2]);

    await pm.connect(pauserGuy).pause();
    await expect(pm.connect(alice).claim(0, amt)).to.be.revertedWithCustomError(pm, "EnforcedPause");

    await pm.connect(pauserGuy).unpause();
    await pm.connect(alice).claim(0, amt);
  });

  it("isolates collateral between two markets", async function () {
    const { pm, token, marketGuy, alice, bob, fund, networkHelpers, sig1, sig2, resolveWithSigs } =
      await deployFixture();
    const end = BigInt(await networkHelpers.time.latest()) + 2000n;
    await pm.connect(marketGuy).createMarket("a", Number(end));
    await pm.connect(marketGuy).createMarket("b", Number(end));

    const a0 = parseEther("80");
    const b1 = parseEther("30");
    await fund(alice.address, a0);
    await fund(bob.address, b1);
    await token.connect(alice).approve(await pm.getAddress(), a0);
    await token.connect(bob).approve(await pm.getAddress(), b1);
    await pm.connect(alice).buyShares(0, true, a0);
    await pm.connect(bob).buyShares(1, true, b1);

    const escrow0 = await pm.marketEscrow(0n);
    const escrow1 = await pm.marketEscrow(1n);
    expect(await token.balanceOf(escrow0)).to.equal(a0);
    expect(await token.balanceOf(escrow1)).to.equal(b1);

    await networkHelpers.time.increaseTo(end + 1n);
    await resolveWithSigs(0n, OUTCOME_YES, [sig1, sig2]);
    await resolveWithSigs(1n, OUTCOME_YES, [sig1, sig2]);

    await pm.connect(alice).claimAll(0);
    expect(await token.balanceOf(escrow0)).to.equal(0n);
    expect(await token.balanceOf(escrow1)).to.equal(b1);
  });

  it("reverts nested buyShares via malicious ERC20 callback (nonReentrant)", async function () {
    const { ethers: eh, networkHelpers } = await network.create();

    const token = await eh.deployContract("contracts/mocks/MockERC20Reentrant.sol:MockERC20Reentrant", []);
    const escrowImpl = await eh.deployContract("CollateralEscrow");
    const pm = await eh.deployContract("PredictionMarket", [await token.getAddress(), "", await escrowImpl.getAddress()]);
    const attacker = await eh.deployContract("contracts/mocks/ReentrancyBuyer.sol:ReentrancyBuyer", [
      await pm.getAddress(),
    ]);

    const [deployer, s1, s2] = await eh.getSigners();
    await pm.connect(deployer).setResolutionConfig([s1.address, s2.address], 2);

    const end = BigInt(await networkHelpers.time.latest()) + 5000n;
    await pm.createMarket("m", Number(end));

    const amt = parseEther("1");
    await token.mint(await attacker.getAddress(), amt * 2n);
    await attacker.approveCollateral(MaxUint256);

    await attacker.configure(0n, true, amt);
    await token.setHook(await attacker.getAddress(), true);

    await expect(attacker.start()).to.be.revertedWithCustomError(pm, "ReentrancyGuardReentrantCall");
  });

  it("rejects setResolutionConfig from non-default-admin", async function () {
    const { pm, stranger } = await deployFixture();
    await expect(pm.connect(stranger).setResolutionConfig([stranger.address], 1)).to.be.revertedWithCustomError(
      pm,
      "AccessControlUnauthorizedAccount",
    );
  });

  it("skips invalid signatures and still resolves when threshold met", async function () {
    const { pm, token, marketGuy, alice, fund, networkHelpers, sig1, sig2, sig3 } = await deployFixture();
    const end = BigInt(await networkHelpers.time.latest()) + 300n;
    await pm.connect(marketGuy).createMarket("m", Number(end));
    await fund(alice.address, parseEther("5"));
    await token.connect(alice).approve(await pm.getAddress(), MaxUint256);
    await pm.connect(alice).buyShares(0, true, parseEther("5"));
    await networkHelpers.time.increaseTo(end + 1n);

    const nonce = await pm.resolutionNonces(0n);
    const deadline = BigInt(await networkHelpers.time.latest()) + 3600n;
    const junk = new Wallet(Wallet.createRandom().privateKey);
    const bad = await signResolution(junk, pm, { marketId: 0n, outcome: 2n, deadline, nonce });
    const goodA = await signResolution(sig1, pm, { marketId: 0n, outcome: 1n, deadline, nonce });
    const goodB = await signResolution(sig2, pm, { marketId: 0n, outcome: 1n, deadline, nonce });

    await expect(pm.resolveWithSignatures(0, OUTCOME_YES, deadline, [bad, goodA, goodB])).to.emit(
      pm,
      "MarketResolved",
    );
  });
});
