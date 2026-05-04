// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControlEnumerable} from "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {CollateralEscrow} from "./CollateralEscrow.sol";

/// @title PredictionMarket
/// @notice Production-oriented binary YES/NO markets: ERC1155 positions, parimutuel settlement, per-market collateral escrows,
///         EIP-712 multisig resolution, pausable user flows, and OpenZeppelin access control intended for `TimelockController`
///         as `DEFAULT_ADMIN_ROLE` holder after deployment.
/// @dev **Trust assumptions:** collateral ERC20 must not re-enter on `transfer`/`transferFrom` in a way that breaks accounting;
///      do not use fee-on-transfer or rebasing tokens without a dedicated adapter. Resolution signers are a centralized oracle;
///      this is not suitable where trustless settlement is required. **Not audited.** May not comply with securities or gambling
///      laws in your jurisdiction.
///
/// **Per-market invariant:** `collateralToken.balanceOf(marketEscrow[id]) >= markets[id].collateral` while the market exists.
contract PredictionMarket is ERC1155, AccessControlEnumerable, ReentrancyGuard, Pausable, EIP712 {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @notice Creates/cancels markets.
    bytes32 public constant MARKET_ADMIN_ROLE = keccak256("MARKET_ADMIN_ROLE");
    /// @notice May pause user-facing flows (`buyShares`, `claim`, `refundCancelled`).
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @dev EIP-712 typehash for multisig resolution payloads.
    bytes32 private constant RESOLUTION_TYPEHASH =
        keccak256("Resolution(uint256 marketId,uint8 outcome,uint256 deadline,uint256 nonce)");

    /// @dev Emitted `resolverKind` when settled via EIP-712 threshold signatures.
    uint8 public constant RESOLVER_KIND_MULTISIG_EIP712 = 1;

    IERC20 public immutable collateralToken;
    address public immutable escrowImplementation;

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
    mapping(uint256 marketId => address) public marketEscrow;
    uint256 public marketCount;

    /// @notice Nonce per market consumed on each successful multisig resolution (replay protection).
    mapping(uint256 marketId => uint256) public resolutionNonces;

    EnumerableSet.AddressSet private _resolutionSigners;
    /// @notice Minimum number of distinct valid EIP-712 signatures required to resolve a market.
    uint256 public resolutionThreshold;

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
    error PredictionMarket__ResolutionPastSignatureDeadline();
    error PredictionMarket__InsufficientResolutionSignatures();
    error PredictionMarket__ResolutionNotConfigured();
    error PredictionMarket__DuplicateResolutionSigner();
    error PredictionMarket__InvalidResolutionSigner();
    error PredictionMarket__BadResolutionConfig();
    error PredictionMarket__ZeroEscrowImplementation();
    error PredictionMarket__ZeroCollateral();

    event MarketCreated(uint256 indexed marketId, string metadataURI, uint64 endTime, address indexed escrow);
    event SharesPurchased(uint256 indexed marketId, address indexed buyer, bool indexed isYes, uint256 amount);
    event MarketResolved(
        uint256 indexed marketId,
        Outcome outcome,
        uint8 resolverKind,
        uint256 resolutionNonce,
        uint256 signatureDeadline
    );
    event PayoutClaimed(uint256 indexed marketId, address indexed claimant, uint256 sharesBurned, uint256 payout);
    event MarketCancelled(uint256 indexed marketId);
    event RefundClaimed(uint256 indexed marketId, address indexed claimant, bool indexed isYes, uint256 amount);
    event ResolutionSignersUpdated(uint256 threshold, uint256 signerCount);

    /// @param collateral_ ERC20 used for all markets (e.g. USDT).
    /// @param baseURI_ ERC1155 metadata URI prefix.
    /// @param escrowImplementation_ `CollateralEscrow` logic contract used with `Clones.clone` per market.
    constructor(IERC20 collateral_, string memory baseURI_, address escrowImplementation_)
        ERC1155(baseURI_)
        EIP712("PredictionMarket", "1")
    {
        if (address(collateral_) == address(0)) revert PredictionMarket__ZeroCollateral();
        if (escrowImplementation_ == address(0)) revert PredictionMarket__ZeroEscrowImplementation();
        collateralToken = collateral_;
        escrowImplementation = escrowImplementation_;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MARKET_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
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

    /// @notice Number of addresses authorized to sign resolution payloads.
    function resolutionSignerCount() external view returns (uint256) {
        return _resolutionSigners.length();
    }

    /// @notice Returns the signer stored at `index` (unordered; for introspection only).
    function resolutionSignerAt(uint256 index) external view returns (address) {
        return _resolutionSigners.at(index);
    }

    /// @notice Whether `account` is an authorized resolution signer.
    function isResolutionSigner(address account) external view returns (bool) {
        return _resolutionSigners.contains(account);
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

        address escrow = Clones.clone(escrowImplementation);
        CollateralEscrow(escrow).initialize(collateralToken, address(this));
        marketEscrow[marketId] = escrow;

        markets[marketId] = Market({
            metadataURI: metadataURI,
            endTime: endTime,
            status: Status.Open,
            result: Outcome.None,
            yesShares: 0,
            noShares: 0,
            collateral: 0
        });
        emit MarketCreated(marketId, metadataURI, endTime, escrow);
    }

    /// @notice Replace the authorized resolution signer set and threshold (intended to be invoked via timelocked admin).
    function setResolutionConfig(address[] calldata signers, uint256 threshold) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 len = _resolutionSigners.length();
        for (uint256 i = 0; i < len; ++i) {
            _resolutionSigners.remove(_resolutionSigners.at(0));
        }
        for (uint256 j = 0; j < signers.length; ++j) {
            address s = signers[j];
            if (s == address(0)) revert PredictionMarket__InvalidResolutionSigner();
            if (!_resolutionSigners.add(s)) revert PredictionMarket__DuplicateResolutionSigner();
        }
        if (threshold == 0 || threshold > _resolutionSigners.length()) revert PredictionMarket__BadResolutionConfig();
        resolutionThreshold = threshold;
        emit ResolutionSignersUpdated(threshold, _resolutionSigners.length());
    }

    /// @notice Buy YES or NO shares 1:1 with collateral (`amount` uses collateral decimals). Collateral sits in the market escrow.
    function buyShares(uint256 marketId, bool isYes, uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert PredictionMarket__ZeroAmount();
        Market storage m = _loadOpenMarket(marketId);
        if (block.timestamp > m.endTime) revert PredictionMarket__TradingClosed();

        address escrow = marketEscrow[marketId];
        collateralToken.safeTransferFrom(msg.sender, escrow, amount);

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

    /// @notice Declare YES or NO after trading deadline using EIP-712 signatures from authorized signers.
    /// @param deadline Latest timestamp at which this bundle remains valid (`block.timestamp <= deadline`).
    /// @param signatures ECDSA signatures over the EIP-712 `Resolution` struct (65 bytes each); duplicate signers ignored.
    function resolveWithSignatures(
        uint256 marketId,
        Outcome outcome,
        uint256 deadline,
        bytes[] calldata signatures
    ) external nonReentrant {
        if (outcome != Outcome.Yes && outcome != Outcome.No) revert PredictionMarket__BadOutcome();
        if (resolutionThreshold == 0 || _resolutionSigners.length() == 0) revert PredictionMarket__ResolutionNotConfigured();
        if (block.timestamp > deadline) revert PredictionMarket__ResolutionPastSignatureDeadline();

        Market storage m = _loadOpenMarket(marketId);
        if (block.timestamp <= m.endTime) revert PredictionMarket__ResolutionBeforeDeadline();

        uint256 winning = outcome == Outcome.Yes ? m.yesShares : m.noShares;
        if (winning == 0) revert PredictionMarket__WinningSideEmpty();

        uint256 nonce = resolutionNonces[marketId];
        bytes32 structHash = keccak256(abi.encode(RESOLUTION_TYPEHASH, marketId, uint8(outcome), deadline, nonce));
        bytes32 digest = _hashTypedDataV4(structHash);

        uint256 sigLen = signatures.length;
        if (sigLen < resolutionThreshold) revert PredictionMarket__InsufficientResolutionSignatures();

        address[] memory seen = new address[](sigLen);
        uint256 seenCount;

        for (uint256 i = 0; i < sigLen; ++i) {
            (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecoverCalldata(digest, signatures[i]);
            if (err != ECDSA.RecoverError.NoError || recovered == address(0) || !_resolutionSigners.contains(recovered)) {
                continue;
            }

            bool dup;
            for (uint256 j = 0; j < seenCount; ++j) {
                if (seen[j] == recovered) {
                    dup = true;
                    break;
                }
            }
            if (dup) continue;
            seen[seenCount++] = recovered;
        }

        if (seenCount < resolutionThreshold) revert PredictionMarket__InsufficientResolutionSignatures();

        resolutionNonces[marketId] = nonce + 1;
        m.status = Status.Resolved;
        m.result = outcome;
        emit MarketResolved(marketId, outcome, RESOLVER_KIND_MULTISIG_EIP712, nonce, deadline);
    }

    /// @notice Burn winning shares and withdraw parimutuel payout from the market escrow.
    function claim(uint256 marketId, uint256 amount) external nonReentrant whenNotPaused {
        _claim(msg.sender, marketId, amount);
    }

    /// @notice Claim full winning balance in one call.
    function claimAll(uint256 marketId) external nonReentrant whenNotPaused {
        Market storage m = markets[marketId];
        if (m.status != Status.Resolved) revert PredictionMarket__NotResolved();
        bool isYes = m.result == Outcome.Yes;
        uint256 tokenId = packTokenId(marketId, isYes);
        uint256 amount = balanceOf(msg.sender, tokenId);
        if (amount == 0) revert PredictionMarket__ZeroAmount();
        _claim(msg.sender, marketId, amount);
    }

    /// @notice Cancel an open market (e.g. dispute). Holders refund 1:1 via `refundCancelled`. Callable while paused.
    function cancelMarket(uint256 marketId) external onlyRole(MARKET_ADMIN_ROLE) {
        Market storage m = _loadOpenMarket(marketId);
        m.status = Status.Cancelled;
        emit MarketCancelled(marketId);
    }

    /// @notice After cancellation, burn shares and receive collateral back 1:1 from the market escrow.
    function refundCancelled(uint256 marketId, bool isYes, uint256 amount) external nonReentrant whenNotPaused {
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
        address escrow = marketEscrow[marketId];
        CollateralEscrow(escrow).withdraw(msg.sender, amount);

        emit RefundClaimed(marketId, msg.sender, isYes, amount);
    }

    /// @notice Pause user-facing fund flows (`buyShares`, claims, refunds).
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpause user-facing fund flows.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC1155, AccessControlEnumerable)
        returns (bool)
    {
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
        address escrow = marketEscrow[marketId];
        CollateralEscrow(escrow).withdraw(account, payout);

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
