// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PredictionMarket
/// @notice Binary YES/NO markets backed by a single ERC20 collateral (e.g. USDT).
/// @dev Parimutuel settlement: winning ERC1155 holders redeem pro-rata against total collateral.
///      Peer-to-peer ERC1155 transfers are disabled; only mint/burn via protocol functions.
contract PredictionMarket is ERC1155, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant MARKET_ADMIN_ROLE = keccak256("MARKET_ADMIN_ROLE");
    bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");

    IERC20 public immutable collateralToken;

    enum Outcome {
        None,
        Yes,
        No
    }

    enum Status {
        Open,
        Resolved,
        Cancelled
    }

    struct Market {
        string metadataURI;
        uint64 endTime;
        Status status;
        Outcome result;
        uint256 yesShares;
        uint256 noShares;
        uint256 collateral;
    }

    mapping(uint256 marketId => Market) public markets;
    uint256 public marketCount;

    error PredictionMarket__TransfersDisabled();
    error PredictionMarket__ZeroAmount();
    error PredictionMarket__InvalidMarket();
    error PredictionMarket__BadEndTime();
    error PredictionMarket__NotOpen();
    error PredictionMarket__TradingClosed();
    error PredictionMarket__BadOutcome();
    error PredictionMarket__NotResolved();
    error PredictionMarket__NotCancelled();
    error PredictionMarket__InsufficientShares();
    error PredictionMarket__WinningSideEmpty();
    error PredictionMarket__ResolutionBeforeDeadline();

    event MarketCreated(uint256 indexed marketId, string metadataURI, uint64 endTime);
    event SharesPurchased(uint256 indexed marketId, address indexed buyer, bool indexed isYes, uint256 amount);
    event MarketResolved(uint256 indexed marketId, Outcome outcome);
    event PayoutClaimed(uint256 indexed marketId, address indexed claimant, uint256 sharesBurned, uint256 payout);
    event MarketCancelled(uint256 indexed marketId);
    event RefundClaimed(uint256 indexed marketId, address indexed claimant, bool indexed isYes, uint256 amount);

    constructor(IERC20 collateral_, string memory baseURI_) ERC1155(baseURI_) {
        collateralToken = collateral_;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MARKET_ADMIN_ROLE, msg.sender);
        _grantRole(RESOLVER_ROLE, msg.sender);
    }

    /// @notice Pack `(marketId, isYes)` into a single ERC1155 id (bit0: 0 = YES, 1 = NO).
    function packTokenId(uint256 marketId, bool isYes) public pure returns (uint256 tokenId) {
        tokenId = (marketId << 1) | (isYes ? uint256(0) : uint256(1));
    }

    /// @notice Decode ERC1155 id into market id and side.
    function unpackTokenId(uint256 tokenId) public pure returns (uint256 marketId, bool isYes) {
        marketId = tokenId >> 1;
        isYes = (tokenId & 1) == 0;
    }

    /// @param metadataURI Off-chain metadata pointer (IPFS/HTTPS).
    /// @param endTime Unix timestamp; trades allowed strictly while `block.timestamp <= endTime`.
    function createMarket(string calldata metadataURI, uint64 endTime)
        external
        onlyRole(MARKET_ADMIN_ROLE)
        returns (uint256 marketId)
    {
        if (endTime <= block.timestamp) revert PredictionMarket__BadEndTime();
        marketId = marketCount++;
        markets[marketId] = Market({
            metadataURI: metadataURI,
            endTime: endTime,
            status: Status.Open,
            result: Outcome.None,
            yesShares: 0,
            noShares: 0,
            collateral: 0
        });
        emit MarketCreated(marketId, metadataURI, endTime);
    }

    /// @notice Buy YES or NO shares 1:1 with collateral (`amount` uses collateral decimals).
    function buyShares(uint256 marketId, bool isYes, uint256 amount) external nonReentrant {
        if (amount == 0) revert PredictionMarket__ZeroAmount();
        Market storage m = _loadOpenMarket(marketId);
        if (block.timestamp > m.endTime) revert PredictionMarket__TradingClosed();

        collateralToken.safeTransferFrom(msg.sender, address(this), amount);

        if (isYes) {
            m.yesShares += amount;
        } else {
            m.noShares += amount;
        }
        m.collateral += amount;

        uint256 id = packTokenId(marketId, isYes);
        _mint(msg.sender, id, amount, "");

        emit SharesPurchased(marketId, msg.sender, isYes, amount);
    }

    /// @notice Resolver declares YES or NO after trading deadline (`block.timestamp > endTime`).
    function resolve(uint256 marketId, Outcome outcome) external onlyRole(RESOLVER_ROLE) {
        if (outcome != Outcome.Yes && outcome != Outcome.No) revert PredictionMarket__BadOutcome();
        Market storage m = _loadOpenMarket(marketId);
        if (block.timestamp <= m.endTime) revert PredictionMarket__ResolutionBeforeDeadline();

        uint256 winning = outcome == Outcome.Yes ? m.yesShares : m.noShares;
        if (winning == 0) revert PredictionMarket__WinningSideEmpty();

        m.status = Status.Resolved;
        m.result = outcome;
        emit MarketResolved(marketId, outcome);
    }

    /// @notice Burn winning shares and withdraw parimutuel payout.
    function claim(uint256 marketId, uint256 amount) external nonReentrant {
        _claim(msg.sender, marketId, amount);
    }

    /// @notice Claim full winning balance in one call.
    function claimAll(uint256 marketId) external nonReentrant {
        Market storage m = markets[marketId];
        if (m.status != Status.Resolved) revert PredictionMarket__NotResolved();
        bool isYes = m.result == Outcome.Yes;
        uint256 tokenId = packTokenId(marketId, isYes);
        uint256 amount = balanceOf(msg.sender, tokenId);
        if (amount == 0) revert PredictionMarket__ZeroAmount();
        _claim(msg.sender, marketId, amount);
    }

    /// @notice Cancel an open market (e.g. dispute). Holders refund 1:1 via `refundCancelled`.
    function cancelMarket(uint256 marketId) external onlyRole(MARKET_ADMIN_ROLE) {
        Market storage m = _loadOpenMarket(marketId);
        m.status = Status.Cancelled;
        emit MarketCancelled(marketId);
    }

    /// @notice After cancellation, burn shares and receive collateral back 1:1.
    function refundCancelled(uint256 marketId, bool isYes, uint256 amount) external nonReentrant {
        if (amount == 0) revert PredictionMarket__ZeroAmount();
        Market storage m = markets[marketId];
        if (m.status != Status.Cancelled) revert PredictionMarket__NotCancelled();

        uint256 tokenId = packTokenId(marketId, isYes);
        if (balanceOf(msg.sender, tokenId) < amount) revert PredictionMarket__InsufficientShares();

        if (isYes) {
            m.yesShares -= amount;
        } else {
            m.noShares -= amount;
        }
        m.collateral -= amount;

        _burn(msg.sender, tokenId, amount);
        collateralToken.safeTransfer(msg.sender, amount);

        emit RefundClaimed(marketId, msg.sender, isYes, amount);
    }

    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function _claim(address account, uint256 marketId, uint256 amount) private {
        if (amount == 0) revert PredictionMarket__ZeroAmount();
        Market storage m = markets[marketId];
        if (m.status != Status.Resolved) revert PredictionMarket__NotResolved();

        bool isYes = m.result == Outcome.Yes;
        uint256 tokenId = packTokenId(marketId, isYes);
        if (balanceOf(account, tokenId) < amount) revert PredictionMarket__InsufficientShares();

        uint256 winningShares = isYes ? m.yesShares : m.noShares;
        uint256 payout = (m.collateral * amount) / winningShares;

        if (isYes) {
            m.yesShares -= amount;
        } else {
            m.noShares -= amount;
        }
        m.collateral -= payout;

        _burn(account, tokenId, amount);
        collateralToken.safeTransfer(account, payout);

        emit PayoutClaimed(marketId, account, amount, payout);
    }

    function _loadOpenMarket(uint256 marketId) private view returns (Market storage m) {
        if (marketId >= marketCount) revert PredictionMarket__InvalidMarket();
        m = markets[marketId];
        if (m.status != Status.Open) revert PredictionMarket__NotOpen();
    }

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        virtual
        override
    {
        if (from != address(0) && to != address(0)) {
            revert PredictionMarket__TransfersDisabled();
        }
        super._update(from, to, ids, values);
    }
}
