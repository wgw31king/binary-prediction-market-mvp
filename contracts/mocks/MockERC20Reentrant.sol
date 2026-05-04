// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IReentrantHook {
    function onAfterTransferFrom() external;
}

/// @dev ERC20 that optionally calls back after `transferFrom` (tests `nonReentrant` on `buyShares`).
contract MockERC20Reentrant is ERC20 {
    address public hookTarget;
    bool public hookEnabled;

    constructor() ERC20("ReentrantMock", "RETM") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setHook(address target, bool enabled) external {
        hookTarget = target;
        hookEnabled = enabled;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        bool ok = super.transferFrom(from, to, amount);
        if (hookEnabled && hookTarget != address(0)) {
            IReentrantHook(hookTarget).onAfterTransferFrom();
        }
        return ok;
    }
}
