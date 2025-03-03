// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

interface IXAUMMinter {
    function swapForXAUm(
        address user,
        address tokenIn,
        uint256 amountIn
    ) external returns (uint256 amountOut);

    function collectXAUm(address user, uint256 amount) external;
}
