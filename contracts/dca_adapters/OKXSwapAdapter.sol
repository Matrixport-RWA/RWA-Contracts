// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract OKXSwapAdapter is Ownable {

    using SafeERC20 for IERC20;

    address public immutable dca;
    address public immutable dollar;
    address public immutable okxRouter;
    address public immutable usdt;

    error CallFailed(bytes);

    constructor(
        address _dca,
        address _usdt,
        address _dollar,
        address _okxRouter,
        address _okxTokenApprove
    ) Ownable(msg.sender) {
        dca = _dca;
        usdt = _usdt;
        dollar = _dollar;
        okxRouter = _okxRouter;
        IERC20(dollar).approve(_okxTokenApprove, type(uint256).max); // safe, as of this contract not own money, just proxy transfer.
    }

    function approve(address token, address spender, uint amount) onlyOwner public {
        IERC20(token).approve(spender, amount); // spender maybe okx dex TokenApprove address, or else newer;
    }

    function swap(uint dollarAmountIn, bytes memory data) public {
        require(msg.sender == dca, 'ADAPTER_NOT_DCA');
        IERC20(dollar).safeTransferFrom(dca, address(this), dollarAmountIn);
        (bool success, bytes memory result) = okxRouter.call(data);
        if (!success) {
            revert CallFailed(result);
        }
        uint balance = IERC20(usdt).balanceOf(address(this));
        require(balance > 0, 'ADAPTER_INVALID_BALANCE');
        IERC20(usdt).safeTransfer(dca, balance);
        uint dollarBalance = IERC20(dollar).balanceOf(address(this));
        if (dollarBalance > 0) {
            IERC20(dollar).safeTransfer(dca, dollarBalance); // transfer remain dollar to dca;
        }
    }
}
