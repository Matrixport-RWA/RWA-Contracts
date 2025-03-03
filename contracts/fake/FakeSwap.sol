// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
// import "hardhat/console.sol";

contract FakeSwap {

    using SafeERC20 for IERC20;

    address public dollar;
    address public usdt;
    uint public price;

    constructor(address _dollar, address _usdt){
        dollar = _dollar;
        usdt = _usdt;
        price = 1000;
    }

    function setPrice(uint _price) public {
        price = _price;
    }

    function swap(uint amountIn) public {
        IERC20(dollar).transferFrom(msg.sender, address(this), amountIn);
        uint amountOut = amountIn * price / 1000;
        IERC20(usdt).transfer(msg.sender, amountOut);
    }

    function generateCalldata(uint amountIn) public pure returns (bytes memory) {
        return abi.encodeWithSignature("swap(uint256)", amountIn);
    }
}
