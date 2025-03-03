// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

interface IXAUMDCA {
    struct Order {
        uint64 id;
        uint64 interval;
        uint64 lastTradeTime;
        uint32 status;
        uint dollarInitBalance;
        uint dollarPerTrade;
        uint dollarBalance;
        uint dollarShareInitAmount;
        uint dollarShareBalance;
        uint xaumBalance;
        uint xaumPending;
        address owner;
        address receiver;
    }

    function createOrder(address user, uint initDollarAmount, uint amountPerTrade, uint64 interval, address receiver) external;
    function closeOrder(address user, uint64 id, address receiver) external;
    function getActiveOrdersByUser(address user, uint startIndex, uint pageSize) external view returns (Order[] memory);
    function getActiveOrdersLengthByUser(address user) external view returns (uint);
    function getActiveOrders(uint startIndex, uint pageSize) external view returns (Order[] memory, uint activeOrdersCount);
    function getTotalFee(uint initAmount, uint amountPerTrade) external view returns (uint256);
    function getOrdersLength() external view returns (uint);
    function minDollarAmount() external view returns (uint);
}
