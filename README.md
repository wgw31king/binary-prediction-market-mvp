# Mvp-polymarket

Minimal **binary (YES / NO) prediction market**: users stake an ERC20 collateral (e.g. USDT), receive **ERC1155** position tokens, resolver declares the outcome, winners redeem **parimutuel** payouts. Built with **Solidity**, **OpenZeppelin**, **HardHat 3**.

**Disclaimer:** This is educational / MVP code. It uses a **centralized resolver**, has **not been audited**, and may not comply with regulations in your jurisdiction. Use at your own risk.

---

## Features

- **Roles:** `DEFAULT_ADMIN_ROLE`, `MARKET_ADMIN_ROLE` (create / cancel markets), `RESOLVER_ROLE` (resolve after deadline).
- **Trading:** `buyShares(marketId, isYes, amount)` pulls collateral 1:1 and mints ERC1155 ids `tokenId = (marketId << 1) | (isYes ? 0 : 1)`.
- **Settlement:** `resolve` after `endTime`; `claim` / `claimAll` burn winning tokens and pay `payout = collateral * amount / winningShares` (internal accounting stays consistent across partial claims).
- **Cancellation:** `cancelMarket` while open; `refundCancelled` burns tokens and returns collateral 1:1.
- **Safety:** `ReentrancyGuard` on `buyShares`, `claim`, `claimAll`, `refundCancelled`; `SafeERC20`; **no peer-to-peer ERC1155 transfers** (mint/burn only).

---

## 中文概要

- **管理员** 创建市场（元数据 URI + `endTime`），可 **取消** 开放中的市场。
- **用户** 用抵押代币（部署时绑定，一般为 USDT）买入 YES 或 NO 份额（ERC1155）。
- **裁决员** 在截止时间后设置 **YES 或 NO** 胜出；胜方按 **parimutuel** 从总抵押池中按比例领取。
- **安全：** 防重入、访问控制、禁用 ERC1155 二级市场转账。

---

## Requirements

- Node.js **≥ 22** (HardHat 3)
- npm

---

## Setup

```bash
cd Mvp-polymarket
npm install
cp .env.example .env   # optional; needed for Sepolia deploy
```

---

## Test & compile

```bash
npm run build
npm test
```

---

## Deploy

**Local (default EDR network)** — deploys `MockERC20` collateral + `PredictionMarket`:

```bash
npm run deploy:local
```

**Sepolia** — set `SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, and `USDT_ADDRESS` (real collateral on that chain) in `.env`, then:

```bash
npx hardhat run scripts/deploy.ts --network sepolia
```

Optional env vars:

| Variable        | Description                                                |
|-----------------|------------------------------------------------------------|
| `USDT_ADDRESS`  | Collateral ERC20; if empty locally, script deploys a mock  |
| `ADMIN_ADDRESS` | Extra address receiving `MARKET_ADMIN` + `RESOLVER` roles  |
| `BASE_URI`      | ERC1155 metadata base URI (default placeholder in script)  |

---

## Contract layout

| Path | Purpose |
|------|---------|
| [`contracts/PredictionMarket.sol`](contracts/PredictionMarket.sol) | Core market logic |
| [`contracts/mocks/MockERC20.sol`](contracts/mocks/MockERC20.sol) | Test / local collateral |
| [`contracts/mocks/MockERC20Reentrant.sol`](contracts/mocks/MockERC20Reentrant.sol) | Reentrancy test hook token |
| [`test/PredictionMarket.test.ts`](test/PredictionMarket.test.ts) | Mocha + ethers tests |

---

## Events

`MarketCreated`, `SharesPurchased`, `MarketResolved`, `PayoutClaimed`, `MarketCancelled`, `RefundClaimed` — see `PredictionMarket.sol`.

---

## License

MIT — see [LICENSE](LICENSE).
