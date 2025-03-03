// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "./interfaces/IXAUMDCA.sol";

contract XAUMDCARouter is Ownable {

    using SafeERC20 for IERC20;

    mapping(address dollar => address dca) public dcaSet;

    constructor() Ownable(msg.sender){}

    function setDCA(address dollar, address dca) onlyOwner public {
        dcaSet[dollar] = dca;
    }

    function createOrder(address dollar, uint initDollarAmount, uint amountPerTrade, uint64 interval, address receiver) public {
        address dca = _getDCA(dollar);
        IERC20(dollar).safeTransferFrom(msg.sender, address(dca), initDollarAmount);
        IXAUMDCA(dca).createOrder(msg.sender, initDollarAmount, amountPerTrade, interval, receiver);
    }

    function closeOrder(address dollar, uint64 id, address receiver) public {
        address dca = _getDCA(dollar);
        IXAUMDCA(dca).closeOrder(msg.sender, id, receiver);
    }

    function getActiveOrdersByUser(address dollar, address user, uint startIndex, uint pageSize) view external returns (IXAUMDCA.Order[] memory) {
        address dca = _getDCA(dollar);
        return IXAUMDCA(dca).getActiveOrdersByUser(user, startIndex, pageSize);
    }

    function getActiveOrdersLengthByUser(address dollar, address user) public view returns (uint) {
        address dca = _getDCA(dollar);
        return IXAUMDCA(dca).getActiveOrdersLengthByUser(user);
    }

    function getActiveOrders(address dollar, uint startIndex, uint pageSize) public view returns (IXAUMDCA.Order[] memory, uint activeOrdersCount) {
        address dca = _getDCA(dollar);
        return IXAUMDCA(dca).getActiveOrders(startIndex, pageSize);
    }

    function getOrdersLength(address dollar) public view returns (uint) {
        address dca = _getDCA(dollar);
        return IXAUMDCA(dca).getOrdersLength();
    }

    function getTotalFee(address dollar, uint initAmount, uint amountPerTrade) public view returns (uint256) {
        address dca = _getDCA(dollar);
        return IXAUMDCA(dca).getTotalFee(initAmount, amountPerTrade);
    }

    function getMinDollarAmountPerTrade(address dollar) public view returns (uint256) {
        address dca = _getDCA(dollar);
        return IXAUMDCA(dca).minDollarAmount();
    }

    function _getDCA(address dollar) internal view returns (address) {
        address dca = dcaSet[dollar];
        require(dca != address(uint160(0)),'DCA_ROUTER_DOLLAR_DCA_NOT_EXIST');
        return dca;
    }
}
