// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IAAVEPool {
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

contract AUSDTAdapter {

    using SafeERC20 for IERC20;

    address public immutable dca;
    address public immutable dollar;
    address public immutable aaveV3Pool;
    address public immutable usdt;

    constructor(
        address _dca,
        address _usdt,
        address _dollar,
        address _aaveV3Pool
    ) {
        dca = _dca;
        usdt = _usdt;
        dollar = _dollar;
        aaveV3Pool = _aaveV3Pool;
    }

    function swap(uint dollarAmountIn) public {
        require(msg.sender == dca, 'ADAPTER_NOT_DCA');
        IERC20(dollar).safeTransferFrom(dca, address(this), dollarAmountIn);
        IAAVEPool(aaveV3Pool).withdraw(usdt, dollarAmountIn, dca);
    }
}
