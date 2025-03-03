// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import "./DelayedUpgradeable.sol";
import "hardhat/console.sol";
import "./interfaces/IXAUMDCA.sol";
import "./interfaces/IXAUMDCAMinter.sol";

/*
 method                  | caller   | delayed | revoker
-------------------------+----------+---------+---------
upgrade                  | owner    | yes     | revoker
setDelay                 | owner    | yes     | revoker
setOperator              | owner    | yes     | revoker
setRevoker               | owner    | yes     | owner
setFee                   | owner    | no      |
setDCARouter             | owner    | no      |
setLegalAccount          | owner    | no      |
setMinDollarPriceAllowed | owner    | no      |
setMinDollarAmount       | owner    | no      |
setMinTradeInterval      | owner    | no      |
setAdapterWhitelist      | owner    | no      |
setUserBlacklist         | owner    | no      |
setPaused                | owner    | no      |
withdrawERC20            | owner    | no      |
withdrawERC721           | owner    | no      |
claimFee                 | owner    | no      |
createOrder              | router   | no      |
closeOrder               | router   | no      |
executeOrderAndClaim     | operator | no      |
executeOrder             | operator | no      |
collectXAUm              | operator | no      |
claimAllXAUm             | operator | no      |
closeOrderByOperator     | operator | no      |
*/

contract XAUMDCA is OwnableUpgradeable, PausableUpgradeable, DelayedUpgradeable, IXAUMDCA {

    using SafeERC20 for IERC20;

    uint64 public constant MIN_PARAM_SET_DELAY = 1 hours;
    uint32 public constant STATUS_ACTIVE = 1;
    uint32 public constant STATUS_CANCELED = 2;
    uint32 public constant STATUS_COMPLETED_WITHOUT_COLLECT = 3;
    uint32 public constant STATUS_COMPLETED_WITHOUT_CLAIM = 4;
    uint32 public constant STATUS_COMPLETED = 5;

    address public dollar;
    bool public isRebaseToken;
    bool public dollarIsStableToken;
    address public xaum;
    address public stableToken;
    address public minter;
    address public legalAccount;
    uint public minDollarAmount; // minDollarPerTrade
    uint public minTradeInterval;
    uint224 public minDollarPriceAllowed;

    uint64 public delay;
    uint64 public nextDelay;
    uint64 public etNextDelay;

    address public operator;
    address public nextOperator;
    uint64 public etNextOperator;

    address public revoker;
    address public nextRevoker;
    uint64 public etNextRevoker;

    address public router;

    uint256 public fee; // charge specific amount stableToken
    uint256 public feeToClaim; // total fee amount in stableToken since latest claimFee

    uint256 public totalShares;

    Order[] public orders; // all orders, newest order id is orders.length
    mapping(address => uint64[]) public userOrders; // only store active order id.

    mapping(address => bool) public userBlacklist;
    mapping(address => bool) public adapterWhitelist;

    modifier onlyOperator {
        require(msg.sender == operator, 'DCA_NOT_OPERATOR');
        _;
    }

    modifier onlyRouter {
        require(msg.sender == router, 'DCA_NOT_ROUTER');
        _;
    }

    modifier onlyRevoker() {
        require(msg.sender == revoker, 'DCA_NOT_REVOKER');
        _;
    }

    event NewOrder(address indexed user, uint64 id, uint initDollarAmount, uint amountPerTrade, uint64 interval, address receiver);
    event XaumConvert(address indexed user, uint64 id, uint dollarDelta, uint stableTokenDelta, uint xaumAmountOut, uint fee);
    event XaumCollect(address indexed user, uint64 id, uint xaumAmount);
    event XAUmClaimByOperator(address indexed user, uint64 id, uint amount, address receiver, bool isOrderFinished);
    event CloseOrder(address indexed user, uint64 id, address indexed receiver, uint xaumBalance, uint dollarBalance);
    event SetDelayRequest(uint64 oldDelay, uint64 newDelay, uint64 et);
    event SetDelayEffected(uint64 newDelay);
    event SetOperatorRequest(address oldAddr, address newAddr, uint64 et);
    event SetOperatorEffected(address newAddr);
    event SetRevokerRequest(address oldAddr, address newAddr, uint64 et);
    event SetRevokerEffected(address newAddr);

    error CallFailed(bytes);

    function initialize(
        address _minter,
        address _dollar,
        bool _isRebaseToken,
        address _xaum,
        address _stableToken,
        address _legalAccount,
        address _operator,
        address _owner,
        address _router,
        uint64 _delay,
        uint _minDollarAmount
    ) public initializer {
        __Ownable_init(_owner);
        __Pausable_init_unchained();
        delay = _delay;
        minter = _minter;
        dollar = _dollar;
        isRebaseToken = _isRebaseToken;
        xaum = _xaum;
        stableToken = _stableToken;
        legalAccount = _legalAccount;
        operator = _operator;
        router = _router;
        minDollarAmount = _minDollarAmount;
        if (dollar == stableToken) {
            dollarIsStableToken = true;
        }
    }

    function setFee(uint256 _fee) public onlyOwner {
        fee = _fee;
    }

    function setDCARouter(address _newDCARouter) public onlyOwner {
        router = _newDCARouter;
    }

    function setDelay(uint64 _delay) public onlyOwner {
        require(_delay >= MIN_PARAM_SET_DELAY, 'DCA_DELAY_TOO_SMALL');
        uint64 et = etNextDelay;
        if (_delay == nextDelay && et != 0 && et < block.timestamp) {
            delay = _delay;
            emit SetDelayEffected(_delay);
        } else {
            nextDelay = _delay;
            etNextDelay = uint64(block.timestamp) + delay;
            emit SetDelayRequest(delay, _delay, etNextDelay);
        }
    }

    function setRevoker(address _revoker) public onlyOwner {
        _checkZeroAddress(_revoker);
        uint64 et = etNextRevoker;
        if (_revoker == nextRevoker && et != 0 && et < block.timestamp) {
            revoker = _revoker;
            emit SetRevokerEffected(_revoker);
        } else {
            nextRevoker = _revoker;
            etNextRevoker = uint64(block.timestamp) + delay;
            emit SetRevokerRequest(revoker, _revoker, etNextRevoker);
        }
    }

    function setOperator(address _operator) public onlyOwner {
        _checkZeroAddress(_operator);
        uint64 et = etNextOperator;
        if (_operator == nextOperator && et != 0 && et < block.timestamp) {
            operator = _operator;
            emit SetOperatorEffected(_operator);
        } else {
            nextOperator = _operator;
            etNextOperator = uint64(block.timestamp) + delay;
            emit SetOperatorRequest(operator, _operator, etNextOperator);
        }
    }

    function getDelay() internal view override returns (uint64) {
        return delay;
    }

    function revokeNextDelay() public onlyRevoker {
        etNextDelay = 0;
    }

    function revokeNextOperator() public onlyRevoker {
        etNextOperator = 0;
    }

    function revokeNextRevoker() public onlyOwner {
        etNextRevoker = 0;
    }

    function revokeNextUpgrade() public onlyRevoker {
        etNextUpgradeToAndCall = 0;
    }

    function setLegalAccount(address _legalAccount) external onlyOwner {
        legalAccount = _legalAccount;
    }

    function setMinDollarPriceAllowed(uint224 _minDollarPriceAllowed) public onlyOwner {
        minDollarPriceAllowed = _minDollarPriceAllowed;
    }

    function setMinDollarAmount(uint _minDollarAmount) public onlyOwner {
        minDollarAmount = _minDollarAmount;
    }

    function setMinTradeInterval(uint minInterval) public onlyOwner {
        minTradeInterval = minInterval;
    }

    function setAdapterWhitelist(address _adapter, bool isEnabled) public onlyOwner {
        adapterWhitelist[_adapter] = isEnabled;
    }

    function setUserBlacklist(address user, bool inBlacklist) public onlyOwner {
        userBlacklist[user] = inBlacklist;
    }

    function setPaused(bool isPaused) external onlyOwner {
        if (isPaused) {
            _pause();
        } else {
            _unpause();
        }
    }

    function withdrawERC20(address token, address recipient, uint256 amount) public onlyOwner {
        IERC20(token).safeTransfer(recipient, amount);
    }

    function withdrawERC721(address token, address recipient, uint256 tokenId) public onlyOwner {
        IERC721(token).transferFrom(address(this), recipient, tokenId);
    }

    function createOrder(address user, uint initDollarAmount, uint amountPerTrade, uint64 interval, address receiver) public onlyRouter whenNotPaused {
        require(amountPerTrade >= minDollarAmount, 'DCA_INVALID_AMOUNT_PER_TRADE');
        require(initDollarAmount >= amountPerTrade && initDollarAmount % amountPerTrade == 0, 'DCA_INVALID_INIT_DOLLAR_AMOUNT');
        require(interval >= minTradeInterval && interval % minTradeInterval == 0, 'DCA_INVALID_TRADE_INTERVAL');
        require(userBlacklist[user] == false && userBlacklist[receiver] == false, 'DCA_IN_BLACKLIST');

        Order memory order;
        order.id = uint64(orders.length);
        order.owner = user;
        order.dollarInitBalance = initDollarAmount;
        order.dollarPerTrade = amountPerTrade;
        order.interval = interval;
        order.lastTradeTime = uint64(0);
        order.dollarBalance = initDollarAmount;
        order.receiver = receiver;
        if (isRebaseToken) {
            order.dollarShareInitAmount = _mintShareAfterReceiveDollar(initDollarAmount);
            order.dollarShareBalance = order.dollarShareInitAmount;
        }
        order.status = STATUS_ACTIVE;
        orders.push(order);
        userOrders[user].push(order.id);
        emit NewOrder(user, order.id, initDollarAmount, amountPerTrade, interval, receiver);
    }

    function executeOrder(uint64 id, address adapter, bytes memory data) public onlyOperator {
        _executeOrder(id, adapter, data);
    }

    function executeOrderAndClaim(uint64 id, address adapter, bytes memory data) public onlyOperator {
        _executeOrder(id, adapter, data);
        _collectXAUm(id);
        _claimXaum(id);
    }

    function executeOrder(uint64 id) public onlyOperator {
        require(dollarIsStableToken, 'DCA_DOLLAR_MUST_BE_STABLE_TOKEN');
        _executeOrder(id, address(0), "");
    }

    function executeOrderAndClaim(uint64 id) public onlyOperator {
        require(dollarIsStableToken, 'DCA_DOLLAR_MUST_BE_STABLE_TOKEN');
        _executeOrder(id, address(0), "");
        _collectXAUm(id);
        _claimXaum(id);
    }

    function _executeOrder(uint64 id, address adapter, bytes memory data) internal {
        Order storage order = orders[id];
        require(order.status == STATUS_ACTIVE, 'DCA_INVALID_ORDER_STATUS');
        require(block.timestamp >= order.lastTradeTime + order.interval * 95 / 100, 'DCA_NOT_TIME_TO_TRADE');

        uint dollarDelta = order.dollarPerTrade;
        uint stableTokenDelta = order.dollarPerTrade;
        if (!dollarIsStableToken) {
            require(adapterWhitelist[adapter] == true, 'DCA_ADAPTER_NOT_IN_WHITELIST');
            (dollarDelta, stableTokenDelta) = _swapDollarToStableToken(order, adapter, data);
        }
        uint256 feeAmount = fee;
        require(stableTokenDelta > feeAmount, 'DCA_INVALID_STABLE_TOKEN_DELTA');
        feeToClaim += feeAmount;
        stableTokenDelta -= feeAmount;

        if (dollarDelta <= order.dollarBalance) {
            order.dollarBalance -= dollarDelta;
        } else {
            order.dollarBalance = 0;
        }
        if (isRebaseToken) {
            order.dollarShareBalance -= _burnShareAfterSendDollar(dollarDelta);
        }
        order.lastTradeTime = uint64(block.timestamp);

        IERC20(stableToken).safeIncreaseAllowance(minter, stableTokenDelta);
        uint256 amountOut = IXAUMMinter(minter).swapForXAUm(order.owner, stableToken, stableTokenDelta);
        order.xaumPending += amountOut;
        if (order.dollarBalance == 0) {
            order.status = STATUS_COMPLETED_WITHOUT_COLLECT;
            if (order.dollarShareBalance > 0) {
                uint256 shareBalance = order.dollarShareBalance;
                order.dollarShareBalance = 0;
                uint transferAmount = getAmountByShare(shareBalance);
                totalShares -= shareBalance;
                IERC20(dollar).safeTransfer(order.receiver, transferAmount);
            }
        }
        emit XaumConvert(order.owner, id, dollarDelta, stableTokenDelta, amountOut, feeAmount);
    }

    function _swapDollarToStableToken(Order storage order, address adapter, bytes memory data) internal returns (uint dollarDelta, uint stableTokenDelta){
        // Cache storage variables
        uint256 dollarBalance = order.dollarBalance;
        uint256 dollarPerTrade = order.dollarPerTrade;
        address dollarAddr = dollar;
        address stableTokenAddr = stableToken;

        // Get balances once
        uint256 dollarBalanceBefore = IERC20(dollarAddr).balanceOf(address(this));
        uint256 stableTokenBalanceBefore = IERC20(stableTokenAddr).balanceOf(address(this));

        // Calculate allowance amount
        uint256 allowanceAmount;
        if (isRebaseToken && dollarBalance < 2 * dollarPerTrade) {
            allowanceAmount = getAmountByShare(order.dollarShareBalance) + 1; // for share amount convert calculate precision
        } else {
            allowanceAmount = dollarPerTrade;
        }
        IERC20(dollarAddr).forceApprove(adapter, allowanceAmount * 11 / 10); // approve more

        // Execute swap
        (bool success, bytes memory result) = adapter.call(data);
        if (!success) {
            revert CallFailed(result);
        }

        // Get balances after swap
        uint256 dollarBalanceAfter = IERC20(dollarAddr).balanceOf(address(this));
        uint256 stableTokenBalanceAfter = IERC20(stableTokenAddr).balanceOf(address(this));

        // Calculate deltas
        dollarDelta = dollarBalanceBefore - dollarBalanceAfter;
        stableTokenDelta = stableTokenBalanceAfter - stableTokenBalanceBefore;

        // Validate deltas
        require(dollarDelta > 0, 'DCA_DOLLAR_DELTA_MUST_POSITIVE');
        if (isRebaseToken && dollarBalance < 2 * dollarPerTrade) {
            require(dollarDelta <= allowanceAmount, 'DCA_INVALID_DOLLAR_DELTA');
        } else {
            require(dollarDelta <= dollarPerTrade * 11 / 10 && dollarDelta <= dollarBalance, 'DCA_INVALID_DOLLAR_DELTA'); // allow trade a little more than dollarPerTrade every trade
        }
        require(stableTokenDelta > 0, 'DCA_INVALID_STABLE_TOKEN_AMOUNT');

        // Validate price
        uint price = uint224(uint224(stableTokenDelta) * (2**112) / uint112(dollarDelta));
        require(price >= minDollarPriceAllowed, 'DCA_INVALID_DOLLAR_PRICE');

        return (dollarDelta, stableTokenDelta);
    }

    function collectXAUm(uint64 id) public onlyOperator {
        _collectXAUm(id);
    }

    function _collectXAUm(uint64 id) internal {
        Order storage order = orders[id];
        address user = order.owner;
        require(order.status == STATUS_ACTIVE
            || order.status == STATUS_COMPLETED_WITHOUT_COLLECT, 'DCA_INVALID_ORDER_STATUS');
        require(order.xaumPending > 0, 'DCA_INVALID_PENDING_XAUM_AMOUNT');
        uint xaumAmount = order.xaumPending;
        order.xaumPending = 0;
        IXAUMMinter(minter).collectXAUm(user, xaumAmount);
        order.xaumBalance += xaumAmount;
        if (order.status == STATUS_COMPLETED_WITHOUT_COLLECT) {
            order.status = STATUS_COMPLETED_WITHOUT_CLAIM;
        }
        emit XaumCollect(user, id, xaumAmount);
    }

    function claimFee(address receiver) public onlyOwner {
        IERC20(stableToken).safeTransfer(receiver, feeToClaim);
        feeToClaim = 0;
    }

    function claimAllXAUm(uint64 id) public onlyOperator {
        _claimXaum(id);
    }

    function _claimXaum(uint64 id) internal {
        Order storage order = orders[id];
        require(order.status == STATUS_ACTIVE
            || order.status == STATUS_COMPLETED_WITHOUT_CLAIM, 'DCA_INVALID_ORDER_STATUS');
        require(order.xaumBalance > 0, 'DCA_INVALID_XAUM_BALANCE');
        address user = order.owner;
        address receiver = order.receiver;
        uint amount = order.xaumBalance;
        require(userBlacklist[user] == false && userBlacklist[receiver] == false, 'DCA_IN_BLACKLIST');
        order.xaumBalance = 0;
        IERC20(xaum).safeTransfer(receiver, amount);
        if (order.status == STATUS_COMPLETED_WITHOUT_CLAIM) {
            order.status = STATUS_COMPLETED;
            _removeUserOrder(user, id);
            emit XAUmClaimByOperator(user, id, amount, receiver, true);
        } else {
            emit XAUmClaimByOperator(user, id, amount, receiver, false);
        }
    }

    function closeOrder(address user, uint64 id, address receiver) public whenNotPaused onlyRouter {
        require(userBlacklist[user] == false && userBlacklist[receiver] == false, 'DCA_IN_BLACKLIST');
        Order storage order = orders[id];
        require(user == order.owner, 'NOT_ORDER_OWNER');
        require(receiver == user || receiver == order.receiver, 'DCA_INVALID_RECEIVER');
        require(order.xaumPending == 0, 'DCA_HAS_PENDING_XAUM');

        _closeOrder(order, user, id, receiver);
    }

    function closeOrderByOperator(uint64 id) public onlyOperator {
        Order storage order = orders[id];
        require(userBlacklist[order.owner] == true, 'DCA_NOT_IN_BLACKLIST');
        _closeOrder(order, order.owner, id, legalAccount);
    }

    function _closeOrder(Order storage order, address user, uint64 id, address receiver) internal {
        require(order.status == STATUS_ACTIVE, 'DCA_INVALID_ORDER_STATUS');

        uint xaumBalance = order.xaumBalance;
        uint dollarBalance = order.dollarBalance;

        if (xaumBalance > 0) {
            order.xaumBalance = 0;
            IERC20(xaum).safeTransfer(receiver, xaumBalance);
        }
        if (dollarBalance > 0) {
            order.dollarBalance = 0;
            if (isRebaseToken) {
                uint256 shareBalance = order.dollarShareBalance;
                order.dollarShareBalance = 0;
                dollarBalance = getAmountByShare(shareBalance);
                totalShares -= shareBalance;
            }
            IERC20(dollar).safeTransfer(receiver, dollarBalance);
        }
        order.status = STATUS_CANCELED;
        _removeUserOrder(user, id);
        emit CloseOrder(user, id, receiver, xaumBalance, dollarBalance);
    }

    function _mintShareAfterReceiveDollar(uint256 dollarAmount) internal returns (uint256 share) {
        uint256 balance = IERC20(dollar).balanceOf(address(this));
        if (totalShares == 0) {
            totalShares = dollarAmount;
            return dollarAmount;
        } else {
            share = totalShares * dollarAmount / (balance - dollarAmount);
            totalShares += share;
            return share;
        }
    }

    function _burnShareAfterSendDollar(uint256 dollarAmount) internal returns (uint256 share) {
        uint256 balance = IERC20(dollar).balanceOf(address(this));
        share = totalShares * dollarAmount / (balance + dollarAmount);
        totalShares -= share;
        return share;
    }

    function _removeUserOrder(address user, uint64 id) internal {
        uint64[] storage orderIds = userOrders[user];
        for (uint i = 0; i < orderIds.length; i++) {
            if (orderIds[i] == id) {
                if (i != orderIds.length -1) {
                    orderIds[i] = orderIds[orderIds.length - 1];
                }
                orderIds.pop();
                break;
            }
        }
    }

    function getAmountByShare(uint256 share) public view returns (uint256 amount) {
        return IERC20(dollar).balanceOf(address(this)) * share / totalShares;
    }

    function getOrder(uint64 id) public view returns (Order memory) {
        return orders[id];
    }

    function getActiveOrders(uint startIndex, uint pageSize) public view returns (Order[] memory, uint activeOrdersCount) {
        Order[] memory _orders = new Order[](pageSize);
        uint k = 0;
        for (uint i = startIndex; i < orders.length && i < startIndex + pageSize; i++) {
            Order memory order = orders[i];
            if (order.status != STATUS_COMPLETED && order.status != STATUS_CANCELED) {
                _orders[k] = order;
                k++;
            }
        }
        return (_orders, k);
    }

    function getOrdersLength() public view returns (uint) {
        return orders.length;
    }

    function getActiveOrdersLengthByUser(address user) public view returns (uint) {
        return userOrders[user].length;
    }

    function getActiveOrdersByUser(address user, uint startIndex, uint pageSize) public view returns (Order[] memory) {
        uint64[] memory orderIds = userOrders[user];
        Order[] memory _orders = new Order[](pageSize);
        for (uint i = startIndex; i < orderIds.length && i < startIndex + pageSize; i++) {
            _orders[i-startIndex] = orders[orderIds[i]];
        }
        return _orders;
    }

    function getTotalFee(uint initAmount, uint amountPerTrade) public view returns (uint256) {
        return fee * ((initAmount + amountPerTrade - 1) / amountPerTrade);
    }
}

contract XAUMDCAForTest is XAUMDCA {
    function setRebaseTokenToggle(bool _isRebaseToken) public {
        isRebaseToken = _isRebaseToken;
    }
}

