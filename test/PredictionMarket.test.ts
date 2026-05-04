import { expect } from "chai";
import { MaxUint256, parseEther } from "ethers";
import { network } from "hardhat";

describe("PredictionMarket", function () {
  async function deployFixture() {
    const { ethers: eh, networkHelpers } = await network.create();
    const [deployer, marketGuy, resolverGuy, alice, bob, stranger] = await eh.getSigners();

    const token = await eh.deployContract("contracts/mocks/MockERC20.sol:MockERC20", [
      "Mock USD",
      "mUSD",
      18,
    ]);
    const tokenAddr = await token.getAddress();

    const pm = await eh.deployContract("PredictionMarket", [tokenAddr, "https://example.invalid/{id}.json"]);

    const MARKET_ADMIN_ROLE = await pm.MARKET_ADMIN_ROLE();
    const RESOLVER_ROLE = await pm.RESOLVER_ROLE();

    await pm.connect(deployer).grantRole(MARKET_ADMIN_ROLE, marketGuy.address);
    await pm.connect(deployer).grantRole(RESOLVER_ROLE, resolverGuy.address);
    await pm.connect(deployer).revokeRole(MARKET_ADMIN_ROLE, deployer.address);
    await pm.connect(deployer).revokeRole(RESOLVER_ROLE, deployer.address);

    const fund = async (to: string, amount: bigint) => {
      await token.mint(to, amount);
    };

    return {
      ethers: eh,
      networkHelpers,
      deployer,
      marketGuy,
      resolverGuy,
      alice,
      bob,
      stranger,
      token,
      pm,
      MARKET_ADMIN_ROLE,
      RESOLVER_ROLE,
      fund,
    };
  }

  it("creates a market and emits MarketCreated", async function () {
    const { pm, marketGuy, networkHelpers } = await deployFixture();
    const end = BigInt(await networkHelpers.time.latest()) + 10_000n;
    await expect(pm.connect(marketGuy).createMarket("ipfs://q", Number(end)))
      .to.emit(pm, "MarketCreated")
      .withArgs(0n, "ipfs://q", end);
    expect(await pm.marketCount()).to.equal(1n);
  });

  it("rejects createMarket from address without MARKET_ADMIN_ROLE", async function () {
    const { pm, stranger, networkHelpers } = await deployFixture();
    const end = BigInt(await networkHelpers.time.latest()) + 100n;
    await expect(pm.connect(stranger).createMarket("x", Number(end))).to.be.revertedWithCustomError(
      pm,
      "AccessControlUnauthorizedAccount",
    );
  });

  it("buyShares mints ERC1155 1:1 and pulls collateral", async function () {
    const { pm, token, marketGuy, alice, fund, networkHelpers } = await deployFixture();
    const end = BigInt(await networkHelpers.time.latest()) + 10_000n;
    await pm.connect(marketGuy).createMarket("m", Number(end));

    const amt = parseEther("100");
    await fund(alice.address, amt);
    await token.connect(alice).approve(await pm.getAddress(), amt);

    await expect(pm.connect(alice).buyShares(0, true, amt))
      .to.emit(pm, "SharesPurchased")
      .withArgs(0n, alice.address, true, amt);

    const yesId = await pm.packTokenId(0n, true);
    expect(await pm.balanceOf(alice.address, yesId)).to.equal(amt);
    expect(await token.balanceOf(alice.address)).to.equal(0n);
    expect(await token.balanceOf(await pm.getAddress())).to.equal(amt);

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

  it("resolves after deadline and pays parimutuel winners", async function () {
    const { pm, token, marketGuy, resolverGuy, alice, bob, fund, networkHelpers } = await deployFixture();
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

    await expect(pm.connect(resolverGuy).resolve(0, 1)).to.emit(pm, "MarketResolved").withArgs(0n, 1n); // Yes

    const before = await token.balanceOf(alice.address);
    const yesId = await pm.packTokenId(0n, true);
    await expect(pm.connect(alice).claim(0, aYes)).to.emit(pm, "PayoutClaimed").withArgs(0n, alice.address, aYes, aYes + bNo);
    expect(await token.balanceOf(alice.address)).to.equal(before + aYes + bNo);

    expect(await pm.balanceOf(alice.address, yesId)).to.equal(0n);
    expect(await token.balanceOf(await pm.getAddress())).to.equal(0n);
  });

  it("distributes partial claims proportionally", async function () {
    const { pm, token, marketGuy, resolverGuy, alice, bob, fund, networkHelpers } = await deployFixture();
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
    await pm.connect(resolverGuy).resolve(0, 1);

    const half = parseEther("50");
    await pm.connect(alice).claim(0, half);
    await pm.connect(bob).claim(0, bAmt);
    await pm.connect(alice).claimAll(0);

    expect(await token.balanceOf(await pm.getAddress())).to.equal(0n);
  });

  it("reverts resolve if winning side has zero shares", async function () {
    const { pm, token, marketGuy, resolverGuy, alice, fund, networkHelpers } = await deployFixture();
    const end = BigInt(await networkHelpers.time.latest()) + 200n;
    await pm.connect(marketGuy).createMarket("m", Number(end));

    await fund(alice.address, parseEther("10"));
    await token.connect(alice).approve(await pm.getAddress(), MaxUint256);
    await pm.connect(alice).buyShares(0, false, parseEther("10"));

    await networkHelpers.time.increaseTo(end + 1n);

    await expect(pm.connect(resolverGuy).resolve(0, 1)).to.be.revertedWithCustomError(
      pm,
      "PredictionMarket__WinningSideEmpty",
    );
  });

  it("reverts resolve before deadline", async function () {
    const { pm, marketGuy, resolverGuy, networkHelpers } = await deployFixture();
    const end = BigInt(await networkHelpers.time.latest()) + 10_000n;
    await pm.connect(marketGuy).createMarket("m", Number(end));

    await expect(pm.connect(resolverGuy).resolve(0, 1)).to.be.revertedWithCustomError(
      pm,
      "PredictionMarket__ResolutionBeforeDeadline",
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

  it("cancelMarket allows 1:1 refunds", async function () {
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

  it("reverts nested buyShares via malicious ERC20 callback (nonReentrant)", async function () {
    const { ethers: eh, networkHelpers } = await network.create();

    const token = await eh.deployContract("contracts/mocks/MockERC20Reentrant.sol:MockERC20Reentrant", []);
    const pm = await eh.deployContract("PredictionMarket", [await token.getAddress(), ""]);
    const attacker = await eh.deployContract("contracts/mocks/ReentrancyBuyer.sol:ReentrancyBuyer", [
      await pm.getAddress(),
    ]);

    const end = BigInt(await networkHelpers.time.latest()) + 5000n;
    await pm.createMarket("m", Number(end));

    const amt = parseEther("1");
    await token.mint(await attacker.getAddress(), amt * 2n);
    await attacker.approveCollateral(MaxUint256);

    await attacker.configure(0n, true, amt);
    await token.setHook(await attacker.getAddress(), true);

    await expect(attacker.start()).to.be.revertedWithCustomError(pm, "ReentrancyGuardReentrantCall");
  });
});
