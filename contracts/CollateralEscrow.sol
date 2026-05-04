// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title CollateralEscrow
/// @notice Holds ERC20 collateral for a single prediction market instance; only the factory `PredictionMarket` may move funds.
/// @dev Deployed as an EIP-1167 minimal proxy per market for physical isolation of pooled collateral.
contract CollateralEscrow is Initializable {
    using SafeERC20 for IERC20;

    IERC20 public collateralToken;
    address public market;

    error CollateralEscrow__OnlyMarket();
    error CollateralEscrow__ZeroAddress();

    modifier onlyMarket() {
        if (msg.sender != market) revert CollateralEscrow__OnlyMarket();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param collateralToken_ ERC20 accepted for this market (same asset as protocol collateral).
    /// @param market_ The `PredictionMarket` factory that owns this escrow.
    function initialize(IERC20 collateralToken_, address market_) external initializer {
        if (address(collateralToken_) == address(0) || market_ == address(0)) {
            revert CollateralEscrow__ZeroAddress();
        }
        collateralToken = collateralToken_;
        market = market_;
    }

    /// @notice Send `amount` collateral from this escrow to `to`.
    function withdraw(address to, uint256 amount) external onlyMarket {
        collateralToken.safeTransfer(to, amount);
    }
}
