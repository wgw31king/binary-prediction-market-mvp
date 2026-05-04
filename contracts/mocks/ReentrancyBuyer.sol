// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PredictionMarket} from "../PredictionMarket.sol";

/// @dev Attempts `buyShares` reentrancy when collateral token fires a hook.
contract ReentrancyBuyer {
    PredictionMarket public immutable market;
    uint256 public marketId;
    bool public isYes;
    uint256 public amount;

    constructor(PredictionMarket market_) {
        market = market_;
    }

    function approveCollateral(uint256 allowance_) external {
        IERC20(market.collateralToken()).approve(address(market), allowance_);
    }

    function configure(uint256 marketId_, bool isYes_, uint256 amount_) external {
        marketId = marketId_;
        isYes = isYes_;
        amount = amount_;
    }

    function start() external {
        market.buyShares(marketId, isYes, amount);
    }

    function onAfterTransferFrom() external {
        market.buyShares(marketId, isYes, amount);
    }
}
