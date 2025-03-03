// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./DelayedUpgradeable.sol";

import "./interfaces/IXAUMDCAMinter.sol";

/*
 method              | caller        | delayed | revoker 
---------------------+---------------+---------+---------
upgrade              | owner         | yes     | revoker
setDelay             | owner         | yes     | revoker
setPriceOperator     | owner         | yes     | revoker
setFundOperator      | owner         | yes     | revoker
setFundRecipient     | owner         | yes     | revoker
setMinPrice          | owner         | yes     | revoker
setMaxPrice          | owner         | yes     | revoker
setRevoker           | owner         | yes     | owner
setUSD               | owner         | no      | 
setDCA               | owner         | no      |
withdrawERC20        | owner         | no      |
withdrawERC721       | owner         | no      |
withdrawForRebalance | fundOperator  | no      |
setFixedPrice        | priceOperator | no      |
swapForXAUm          | DCA           | no      |
collectXAUm          | DCA           | no      |
*/

contract XAUMDCAMinter is DelayedUpgradeable, IXAUMMinter {
    using SafeERC20 for IERC20;

    // errors
    error NotRevoker(address);
    error NotPriceOperator(address);
    error NotFundOperator(address);
    error NotDCA(address);
    error DelayTooSmall();
    error InvalidPriceLimit(uint256 minPrice, uint256 maxPrice);
    error NoSystemFundRecipient();
    error SignatureExpired(uint256);
    error TokenInNotInWhitelist(address tokenIn);
    error PriceOutOfRange(uint256 price);
    error FixedPriceExpired();
    error NotEnoughSystemXAUm(uint256 have, uint256 need);
    error NotEnoughUserXAUm(address user, uint256 have, uint256 need);
    error ZeroTokenRecipient();

    // events

    event SetDelayRequest(uint64 oldDelay, uint64 newDelay, uint64 et);
    event SetDelayEffected(uint64 newDelay);
    event SetRevokerRequest(address oldAddr, address newAddr, uint64 et);
    event SetRevokerEffected(address newAddr);
    event SetPriceOperatorRequest(address oldAddr, address newAddr, uint64 et);
    event SetPriceOperatorEffected(address newAddr);
    event SetFundOperatorRequest(address oldAddr, address newAddr, uint64 et);
    event SetFundOperatorEffected(address newAddr);
    event SetFundRecipientRequest(address oldAddr, address newAddr, uint64 et);
    event SetFundRecipientEffected(address newAddr);
    event SetMinPriceRequest(uint256 oldVal, uint256 newVal, uint64 et);
    event SetMinPriceEffected(uint256 newVal);
    event SetMaxPriceRequest(uint256 oldVal, uint256 newVal, uint64 et);
    event SetMaxPriceEffected(uint256 newVal);
    event SetFixedPrice(uint256 price, uint64 expirationTime);
    event SetRecipient(address indexed user, address indexed recipient);
    event SetUSD(address indexed token, bool flag);
    event SetDCA(address indexed dca, bool flag);
    event WithdrawSystemFund(address indexed token, uint256 amount);

    event SwapForXAUm(
        address indexed dca,
        address indexed user,
        address indexed tokenIn,
        uint256 amountIn,
        uint256 amountOut
    );

    event CollectXAUm(
        address indexed dca,
        address indexed user,
        uint256 amount
    );

    // modifiers

    modifier onlyRevoker() {
        if (msg.sender != revoker) {
            revert NotRevoker(msg.sender);
        }
        _;
    }

    modifier onlyFundOperator() {
        if (msg.sender != fundOperator) {
            revert NotFundOperator(msg.sender);
        }
        _;
    }

    modifier onlyPriceOperator() {
        if (msg.sender != priceOperator) {
            revert NotPriceOperator(msg.sender);
        }
        _;
    }

    modifier onlyDCA() {
        if (! dcaMap[msg.sender]) {
            revert NotDCA(msg.sender);
        }
        _;
    }

    // constants
    uint64 constant MIN_DELAY = 1 hours;

    // state variables
    // et = effective time

    address public xaum; // the XAUm contract

    uint64 public delay;
    uint64 public nextDelay;
    uint64 public etNextDelay;

    address public revoker;
    address public nextRevoker;
    uint64 public etNextRevoker;

    address public priceOperator;
    address public nextPriceOperator;
    uint64 public etNextPriceOperator;

    address public fundOperator;
    address public nextFundOperator;
    uint64 public etNextFundOperator;

    address public fundRecipient;
    address public nextFundRecipient;
    uint64 public etNextFundRecipient;

    uint256 public minPrice;
    uint256 public nextMinPrice;
    uint64 public etNextMinPrice;

    uint256 public maxPrice;
    uint256 public nextMaxPrice;
    uint64 public etNextMaxPrice;

    uint256 private fixedPrice;
    uint64 private fixedPriceExpirationTime;

    mapping(address dca => bool) public dcaMap;
    mapping(address token => bool) public usdWhitelist;
    mapping(address dca => mapping(address user => uint256 amt)) public xaumBalances;

    function initialize(
        address _xaum,
        address _owner,
        address _revoker,
        address _priceOperator,
        address _fundOperator,
        address _fundRecipient,
        uint64 _delay,
        uint256 _minPrice,
        uint256 _maxPrice
    ) public initializer {
        __XAUMDCAMinter_init(
            _xaum,
            _owner,
            _revoker,
            _priceOperator,
            _fundOperator,
            _fundRecipient,
            _delay,
            _minPrice,
            _maxPrice
        );
    }

    function __XAUMDCAMinter_init(
        address _xaum,
        address _owner,
        address _revoker,
        address _priceOperator,
        address _fundOperator,
        address _fundRecipient,
        uint64 _delay,
        uint256 _minPrice,
        uint256 _maxPrice
    ) internal onlyInitializing {
        checkPriceLimit(_minPrice, _maxPrice);
        __Ownable_init(_owner);
        xaum = _xaum;
        revoker = _revoker;
        priceOperator = _priceOperator;
        fundOperator = _fundOperator;
        fundRecipient = _fundRecipient;
        delay = _delay;
        minPrice = _minPrice;
        maxPrice = _maxPrice;
    }

    function getDelay() internal view override returns (uint64) {
        return delay;
    }

    function revokeNextUpgrade() public onlyRevoker {
        etNextUpgradeToAndCall = 0;
    }

    function setDelay(uint64 _delay) public onlyOwner {
        if (_delay < MIN_DELAY) {
            revert DelayTooSmall();
        }

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

    function revokeNextDelay() public onlyRevoker {
        etNextDelay = 0;
    }

    function setRevoker(address newRevoker) public onlyOwner {
        _checkZeroAddress(newRevoker);
        uint64 et = etNextRevoker;
        if (newRevoker == nextRevoker && et != 0 && et < block.timestamp) {
            revoker = newRevoker;
            emit SetRevokerEffected(newRevoker);
        } else {
            nextRevoker = newRevoker;
            etNextRevoker = uint64(block.timestamp) + delay;
            emit SetRevokerRequest(revoker, newRevoker, etNextRevoker);
        }
    }

    function revokeNextRevoker() public onlyOwner {
        etNextRevoker = 0;
    }

    function setPriceOperator(address newPriceOperator) public onlyOwner {
        _checkZeroAddress(newPriceOperator);
        uint64 et = etNextPriceOperator;
        if (newPriceOperator == nextPriceOperator && et != 0 && et < block.timestamp) {
            priceOperator = newPriceOperator;
            emit SetPriceOperatorEffected(newPriceOperator);
        } else {
            nextPriceOperator = newPriceOperator;
            etNextPriceOperator = uint64(block.timestamp) + delay;
            emit SetPriceOperatorRequest(priceOperator, newPriceOperator, etNextPriceOperator);
        }
    }

    function revokeNextPriceOperator() public onlyRevoker {
        etNextPriceOperator = 0;
    }

    function setFundOperator(address newFundOperator) public onlyOwner {
        _checkZeroAddress(newFundOperator);
        uint64 et = etNextFundOperator;
        if (newFundOperator == nextFundOperator && et != 0 && et < block.timestamp) {
            fundOperator = newFundOperator;
            emit SetFundOperatorEffected(newFundOperator);
        } else {
            nextFundOperator = newFundOperator;
            etNextFundOperator = uint64(block.timestamp) + delay;
            emit SetFundOperatorRequest(fundOperator, newFundOperator, etNextFundOperator);
        }
    }

    function revokeNextFundOperator() public onlyRevoker {
        etNextFundOperator = 0;
    }

    function setFundRecipient(address newFundRecipient) external onlyOwner {
        _checkZeroAddress(newFundRecipient);
        uint64 et = etNextFundRecipient;
        if (newFundRecipient == nextFundRecipient && et != 0 && et < block.timestamp) {
            fundRecipient = newFundRecipient;
            emit SetFundRecipientEffected(newFundRecipient);
        } else {
            nextFundRecipient = newFundRecipient;
            etNextFundRecipient = uint64(block.timestamp) + delay;
            emit SetFundRecipientRequest(fundRecipient, newFundRecipient, etNextFundRecipient);
        }
    }

    function revokeNextFundRecipient() public onlyRevoker {
        etNextFundRecipient = 0;
    }

    function setMinPrice(uint256 newMinPrice) public onlyOwner {
        checkPriceLimit(newMinPrice, maxPrice);
        uint64 et = etNextMinPrice;
        if (newMinPrice == nextMinPrice && et != 0 && et < block.timestamp) {
            minPrice = newMinPrice;
            emit SetMinPriceEffected(newMinPrice);
        } else {
            nextMinPrice = newMinPrice;
            etNextMinPrice = uint64(block.timestamp) + getDelay();
            emit SetMinPriceRequest(minPrice, newMinPrice, etNextMinPrice);
        }
    }

    function revokeNextMinPrice() public onlyRevoker {
        etNextMinPrice = 0;
    }

    function setMaxPrice(uint256 newMaxPrice) public onlyOwner {
        checkPriceLimit(minPrice, newMaxPrice);
        uint64 et = etNextMaxPrice;
        if (newMaxPrice == nextMaxPrice && et != 0 && et < block.timestamp) {
            maxPrice = newMaxPrice;
            emit SetMaxPriceEffected(newMaxPrice);
        } else {
            nextMaxPrice = newMaxPrice;
            etNextMaxPrice = uint64(block.timestamp) + getDelay();
            emit SetMaxPriceRequest(maxPrice, newMaxPrice, etNextMaxPrice);
        }
    }

    function revokeNextMaxPrice() public onlyRevoker {
        etNextMaxPrice = 0;
    }

    function checkPriceLimit(uint256 _minPrice, uint256 _maxPrice) private pure {
        if (_minPrice > _maxPrice) {
            revert InvalidPriceLimit(_minPrice, _maxPrice);
        }
    }

    function setUSD(address token, bool flag) external onlyOwner {
        usdWhitelist[token] = flag;
        emit SetUSD(token, flag);
    }

    function setDCA(address dca, bool flag) external onlyOwner {
        dcaMap[dca] = flag;
        emit SetDCA(dca, flag);
    }

    function withdrawERC20(address token, address recipient, uint256 amount) external onlyOwner {
        if (recipient == address(0)) {
            revert ZeroTokenRecipient();
        }
        IERC20(token).safeTransfer(recipient, amount);
    }

    function withdrawERC721(address token, address recipient, uint256 tokenId) external onlyOwner {
        if (recipient == address(0)) {
            revert ZeroTokenRecipient();
        }
        IERC721(token).transferFrom(address(this), recipient, tokenId);
    }

    function withdrawForRebalance(address token, uint256 amount) external onlyFundOperator {
        if (fundRecipient == address(0)) {
            revert NoSystemFundRecipient();
        }
        IERC20(token).safeTransfer(fundRecipient, amount);
        emit WithdrawSystemFund(token, amount);
    }

    function getFixedPrice() public view returns (uint256 price, uint64 expirationTime) {
        return (fixedPrice, fixedPriceExpirationTime);
    }

    function setFixedPrice(uint256 price, uint64 validPeriod) external onlyPriceOperator {
        if (price > maxPrice || price < minPrice) {
            revert PriceOutOfRange(price);
        }

        uint64 expirationTime = uint64(block.timestamp) + validPeriod;

        fixedPrice = price;
        fixedPriceExpirationTime = expirationTime;

        emit SetFixedPrice(price, expirationTime);
    }

    // swap usd for xaum at fixed price
    function swapForXAUm(
        address user,
        address tokenIn, // whitelisted usd token
        uint256 amountIn
    ) external onlyDCA returns (uint256 amountOut) {
        address dca = msg.sender;
        if (block.timestamp > fixedPriceExpirationTime) {
            revert FixedPriceExpired();
        }
        if (!usdWhitelist[tokenIn]) {
            revert TokenInNotInWhitelist(tokenIn);
        }

        uint8 usdDecimals = IERC20Metadata(tokenIn).decimals();
        uint8 decimalsAdjust = 18 + 18 - usdDecimals;
        amountOut = amountIn * (10 ** decimalsAdjust) / fixedPrice;

        IERC20(tokenIn).safeTransferFrom(dca, address(this), amountIn);
        xaumBalances[dca][user] += amountOut;
        emit SwapForXAUm(dca, user, tokenIn, amountIn, amountOut);
    }

    function collectXAUm(address user, uint256 amount) external onlyDCA {
        address dca = msg.sender;
        uint256 have = xaumBalances[dca][user];
        if (have < amount) {
            revert NotEnoughUserXAUm(user, have, amount);
        }

        uint256 sysBal = IERC20(xaum).balanceOf(address(this));
        if (sysBal < amount) {
            revert NotEnoughSystemXAUm(sysBal, amount);
        }

        xaumBalances[dca][user] -= amount;
        IERC20(xaum).safeTransfer(dca, amount);
        emit CollectXAUm(dca, user, amount);
    }
}
