const {
    time,
    loadFixture,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { expect } = require("chai");
const { ethers } = require("hardhat");

async function getTS(tx) {
    const block = await ethers.provider.getBlock(tx.blockNumber);
    return block.timestamp;
}

const priceDec = 18n;
const xaumDec  = 18n;
const usdtDec  = 18n;

function _price(n) { return n * (10n ** priceDec);}
function _xaum(n)  { return n * (10n ** xaumDec); }
function _usdt(n)  { return n * (10n ** usdtDec); }

// order status
const ORDER_STATUS_ACTIVE = 1;
const ORDER_STATUS_CANCELED = 2;
const ORDER_STATUS_COMPLETED_WITHOUT_COLLECT = 3;
const ORDER_STATUS_COMPLETED_WITHOUT_CLAIM = 4;
const ORDER_STATUS_COMPLETED = 5;

const zeroAddr = '0x0000000000000000000000000000000000000000';

describe("XAUMDCA", function () {

    const _maxPrice = 3n;
    const _midPrice = 2n;
    const _minPrice = 1n;
    const defaultDelay = 3600; // 1h
    const defaultMaxPrice = _price(_maxPrice);
    const defaultMinPrice = _price(_minPrice);
    const defaultMintDollarAmount = 100n;
    // const defaultTradeInterval = 3600;

    const swapAbi = [
        "function swap(uint256 amountIn)"
    ];
    const iface = new ethers.Interface(swapAbi);

    async function deployTestFixture() {
        const [owner, priceOperator, fundOperator, fundRecipient, revoker, operator, legalAccount, alice, bob] = await ethers.getSigners();

        const ERC20 = await ethers.getContractFactory("FakeERC20");
        const xaum = await ERC20.deploy("XAUM", _xaum(1000_000_000n), xaumDec);
        const usdt = await ERC20.deploy("USDT", _usdt(1000_000_000n), usdtDec);
        const dollar = await ERC20.deploy("DOLLAR", _usdt(1000_000_000n), usdtDec);

        await usdt.transfer(alice.address, _usdt(100_000_000n));
        await dollar.transfer(alice.address, _usdt(100_000_000n));

        const Minter = await ethers.getContractFactory("XAUMDCAMinter");
        const minter = await upgrades.deployProxy(Minter,
            [
                xaum.target,
                owner.address, revoker.address,
                priceOperator.address, fundOperator.address, fundRecipient.address,
                defaultDelay, defaultMinPrice, defaultMaxPrice,
            ],
            {kind: "uups"},
        );

        const XAUMDCARouter = await ethers.getContractFactory("XAUMDCARouter");
        const xaumDCARouter = await XAUMDCARouter.deploy();

        const DCA = await ethers.getContractFactory("XAUMDCAForTest");
        const dca = await upgrades.deployProxy(DCA, [
            minter.target,
            dollar.target, false, xaum.target, usdt.target, legalAccount.address, operator.address, owner.address, xaumDCARouter.target,
            defaultDelay, defaultMintDollarAmount,
        ], {kind: "uups"});
        await minter.setDCA(dca, true);
        await xaumDCARouter.setDCA(dollar.target, dca.target);

        // console.log(dca.target);
        await dca.setMinDollarPriceAllowed(2n ** 112n);
        await dca.setMinTradeInterval(1);

        const ROUTER = await ethers.getContractFactory("FakeSwap");
        const router = await ROUTER.deploy(dollar.target, usdt.target);

        await usdt.transfer(router.target, _usdt(100_000_000n));

        await dca.setAdapterWhitelist(router.target, true);

        dca.getOrderStatus = async function(id) {
            const order = await dca.getOrder(id);
            return order[3];
        };
        dca.getUserOrderIds = async function(userAddr) {
            const arr = [];
            const n  = await dca.getActiveOrdersLengthByUser(userAddr);
            for (let i = 0; i < n; i++) {
                arr.push(await dca.userOrders(userAddr, i));
            }
            return arr;
        };

        return {
            dca, minter, dollar, usdt, xaum, router, fakeSwap: router,
            xaumDCARouter, dcaRouter: xaumDCARouter,
            owner, priceOperator, fundOperator, fundRecipient, legalAccount, operator, revoker,
            alice, bob,
        }
    }

    it("init", async function() {
        const {
            minter, xaum,
            owner, priceOperator, fundOperator, fundRecipient, revoker, dca, legalAccount
        } = await loadFixture(deployTestFixture);

        expect(await minter.xaum()).to.equal(xaum.target);
        expect(await minter.dcaMap(dca.target)).to.equal(true);
        expect(await dca.revoker()).to.equal(zeroAddr);
        expect(await dca.delay()).to.equal(defaultDelay);
        expect(await dca.legalAccount()).to.equal(legalAccount.address);
        expect(await dca.minDollarAmount()).to.equal(defaultMintDollarAmount);
    });

    it("set delay", async function () {
        const {
            minter, xaum,
            owner, priceOperator, fundOperator, fundRecipient, revoker, dca, legalAccount
        } = await loadFixture(deployTestFixture);
        await dca.setDelay(2 * defaultDelay);
        expect(await dca.nextDelay()).to.equal(2 * defaultDelay);
        await time.increase(defaultDelay + 1);
        await dca.setDelay(2 * defaultDelay);
        expect(await dca.delay()).to.equal(2 * defaultDelay);
        expect(await dca.isRebaseToken()).to.equal(false);
    });

    describe("delayed set", function () {

        let testCases = [
            {field: 'delay',  initVal: defaultDelay, newVal: defaultDelay * 2},
            {field: 'operator', initVal: null, newVal: '0xb0b'},
            {field: 'revoker', initVal: null, newVal: '0xb0b'},
        ];

        for (let {field, newVal} of testCases) {
            const _Field = field[0].toUpperCase() + field.substring(1);
            const set      = 'set' + _Field;
            const revoke   = 'revokeNext' + _Field;
            const next     = 'next' + _Field;
            const etNext   = 'etNext' + _Field;
            const reqEvent = 'Set' + _Field + 'Request';
            const eftEvent = 'Set' + _Field + 'Effected';

            it(set, async function() {
                const {dca, owner, revoker, alice, bob} = await loadFixture(deployTestFixture);
                await dca.setRevoker(revoker);
                await time.increase(defaultDelay);
                await dca.setRevoker(revoker);
                if (newVal == '0xb0b') {
                    newVal = bob.address;
                }

                if (field != "revoker") {
                    expect(await dca[next]()).to.equal(0n);
                    expect(await dca[etNext]()).to.equal(0);
                }

                // request: only owner
                await expect(dca.connect(alice)[set](newVal))
                    .to.be.revertedWithCustomError(dca, 'OwnableUnauthorizedAccount')
                    .withArgs(alice.address);

                // request: ok, check event
                const initVal = await dca[field]();
                await expect(dca.connect(owner)[set](newVal))
                    .to.emit(dca, reqEvent).withArgs(initVal, newVal, anyValue);
                expect(await dca[field]()).to.equal(initVal);
                expect(await dca[next]()).to.equal(newVal);
                expect(await dca[etNext]()).to.greaterThan(0);

                // revoke: only revoker
                if (field == 'revoker') {
                    await expect(dca.connect(alice)[revoke]())
                        .to.be.revertedWithCustomError(dca, 'OwnableUnauthorizedAccount')
                        .withArgs(alice.address);
                } else {
                    await expect(dca.connect(alice)[revoke]())
                        .to.be.revertedWith('DCA_NOT_REVOKER');
                }

                // revoke: ok
                let _revoker = field == 'revoker' ? owner : revoker;
                await dca.connect(_revoker)[revoke]();
                expect(await dca[field]()).to.equal(initVal);
                expect(await dca[next]()).to.equal(newVal);
                expect(await dca[etNext]()).to.equal(0);

                // request: ok, check et
                const tx1 = await dca.connect(owner)[set](newVal);
                const ts1 = await getTS(tx1);
                expect(await dca[field]()).to.equal(initVal);
                expect(await dca[next]()).to.equal(newVal);
                expect(await dca[etNext]()).to.equal(ts1 + defaultDelay);

                // execute: reset
                const tx2 = await dca.connect(owner)[set](newVal);
                const ts2 = await getTS(tx2);
                expect(await dca[field]()).to.equal(initVal);
                expect(await dca[next]()).to.equal(newVal);
                expect(await dca[etNext]()).to.equal(ts2 + defaultDelay);

                // execute: ok
                await time.increase(defaultDelay + 1);
                await expect(dca.connect(owner)[set](newVal))
                    .to.emit(dca, eftEvent).withArgs(newVal);
                expect(await dca[field]()).to.equal(newVal);
                expect(await dca[next]()).to.equal(newVal);
                expect(await dca[etNext]()).to.equal(ts2 + defaultDelay);

                // revoke: ok
                await dca.connect(owner)[set](initVal);
                expect(await dca[field]()).to.equal(newVal);
                expect(await dca[next]()).to.equal(initVal);
                expect(await dca[etNext]()).to.greaterThan(0);
                await dca.connect(_revoker)[revoke]();
                expect(await dca[etNext]()).to.equal(0);

            }); // end of it
        } // end of for

    }); // end of describe

    it("test dca", async function () {
        const {dca, usdt, dollar, xaum, owner, priceOperator, minter, fakeSwap, operator, alice, bob, xaumDCARouter} = await loadFixture(deployTestFixture);
        // create order
        await dollar.connect(alice).approve(xaumDCARouter, 20_000);
        await expect(xaumDCARouter.connect(alice).createOrder(dollar, 20_000, 10_000, 3600 * 24, bob.address))
            .to.emit(dca, 'NewOrder').withArgs(alice.address, 0, 20_000, 10_000, 3600 * 24, bob.address);
        let order = await dca.getOrder(0);
        expect(order.dollarBalance).to.equal(20_000);
        expect(order.dollarPerTrade).to.equal(10_000);
        expect(await dca.totalShares()).to.equal(0); // as of not rebase token
        const calldata = iface.encodeFunctionData("swap", [10_000]);
        // convert
        const price = _price(_midPrice);
        const validPeriod = 300000;
        await minter.connect(priceOperator).setFixedPrice(price, validPeriod);
        await minter.setUSD(usdt, true);
        await expect(dca.connect(operator).executeOrder(0, fakeSwap.target, calldata)).to.emit(dca, 'XaumConvert')
            .withArgs(alice.address, 0, 10_000, 10_000, 5_000, 0);
        order = await dca.getOrder(0);
        expect(order.dollarBalance).to.equal(20_000 - 10_000);
        expect(order.xaumPending).to.equal(5_000);
        // xaum collect
        await xaum.transfer(minter.target, _xaum(100_000_000n));
        await dca.connect(operator).collectXAUm(0);
        order = await dca.getOrder(0);
        expect(order.xaumPending).to.equal(0);
        expect(order.xaumBalance).to.equal(5_000);
        // xaum claim
        await dca.connect(operator).claimAllXAUm(0);
        order = await dca.getOrder(0);
        expect(order.xaumBalance).to.equal(0);
        expect(await xaum.balanceOf(bob.address)).to.equal(5000);
        expect(order.status).to.equal(ORDER_STATUS_ACTIVE);

        // last trade
        await time.increase(3600 * 24);
        await expect(dca.connect(operator).executeOrder(0, fakeSwap.target, calldata)).to.emit(dca, 'XaumConvert')
            .withArgs(alice.address, 0, 10_000, 10_000, 5_000, 0);
        order = await dca.getOrder(0);
        expect(order.dollarBalance).to.equal(10_000 - 10_000);
        expect(order.xaumPending).to.equal(5_000);
        expect(order.status).to.equal(ORDER_STATUS_COMPLETED_WITHOUT_COLLECT);
        // trade revert
        await expect(dca.connect(operator).executeOrder(0, fakeSwap.target, calldata))
            .to.be.revertedWith('DCA_INVALID_ORDER_STATUS');
        // xaum collect
        await dca.connect(operator).collectXAUm(0);
        order = await dca.getOrder(0);
        expect(order.xaumPending).to.equal(0);
        expect(order.xaumBalance).to.equal(5_000);
        expect(order.status).to.equal(ORDER_STATUS_COMPLETED_WITHOUT_CLAIM);
        // collect revert
        await expect(dca.connect(operator).collectXAUm(0))
            .to.be.revertedWith('DCA_INVALID_ORDER_STATUS');

        // get user active order
        let activeOrderCount = await dca.getActiveOrdersLengthByUser(alice.address);
        expect(activeOrderCount).to.equal(1);
        let activeOrders = await dca.getActiveOrdersByUser(alice.address, 0, 1);
        expect(activeOrders[0].id).to.equal(0);

        // getActiveOrders(uint startIndex, uint pageSize) public view returns (Order[] memory, uint activeOrdersCount)
        [activeOrders, activeOrderCount] = await dca.getActiveOrders(0, 1);
        expect(activeOrderCount).to.equal(1);
        expect(activeOrders[0].id).to.equal(0);

        // get orders from XAUMDCARouter
        activeOrderCount = await xaumDCARouter.getActiveOrdersLengthByUser(dollar.target, alice.address);
        expect(activeOrderCount).to.equal(1);
        activeOrders = await xaumDCARouter.getActiveOrdersByUser(dollar.target, alice.address, 0, 1);
        expect(activeOrders[0].id).to.equal(0);
        let minAmount = await xaumDCARouter.getMinDollarAmountPerTrade(dollar.target);
        expect(minAmount).to.equal(defaultMintDollarAmount);

        // xaum claim
        await dca.connect(operator).claimAllXAUm(0);
        order = await dca.getOrder(0);
        expect(order.xaumBalance).to.equal(0);
        expect(await xaum.balanceOf(bob.address)).to.equal(10000);
        expect(order.status).to.equal(ORDER_STATUS_COMPLETED);
        expect(order.xaumPending).to.equal(0);
        expect(order.dollarBalance).to.equal(0);
        expect(order.dollarShareBalance).to.equal(0);
        expect(order.dollarShareInitAmount).to.equal(0);

        // collect revert
        await expect(dca.connect(operator).claimAllXAUm(0))
            .to.be.revertedWith('DCA_INVALID_ORDER_STATUS');

        // get user active order
        activeOrderCount = await dca.getActiveOrdersLengthByUser(alice.address);
        expect(activeOrderCount).to.equal(0);
    });

    it("test rebase token versioned dca", async function () {
        const {dca, usdt, dollar, xaum, owner, priceOperator, minter, fakeSwap, operator, alice, bob, xaumDCARouter} = await loadFixture(deployTestFixture);
        // create order
        await dollar.connect(alice).approve(xaumDCARouter, 20_000);
        await dca.setRebaseTokenToggle(true);
        expect(await dca.isRebaseToken()).to.equal(true);
        await expect(xaumDCARouter.connect(alice).createOrder(dollar, 20_000, 10_000, 3600 * 24, bob.address))
            .to.emit(dca, 'NewOrder').withArgs(alice.address, 0, 20_000, 10_000, 3600 * 24, bob.address);
        let order = await dca.getOrder(0);
        expect(order.dollarBalance).to.equal(20_000);
        expect(order.dollarPerTrade).to.equal(10_000);
        expect(order.dollarShareInitAmount).to.equal(20_000);
        expect(order.dollarShareBalance).to.equal(20_000);
        expect(await dca.totalShares()).to.equal(20_000);

        // create order again
        await dollar.connect(alice).approve(xaumDCARouter.target, 20_000);
        await dca.setDCARouter(xaumDCARouter.target);
        await expect(xaumDCARouter.connect(alice).createOrder(dollar.target, 20_000, 20_000, 3600 * 24, bob.address))
            .to.emit(dca, 'NewOrder').withArgs(alice.address, 1, 20_000, 20_000, 3600 * 24, bob.address);
        order = await dca.getOrder(1);
        expect(order.dollarBalance).to.equal(20_000);
        expect(order.dollarPerTrade).to.equal(20_000);
        expect(order.dollarShareInitAmount).to.equal(20_000);
        expect(order.dollarShareBalance).to.equal(20_000);
        expect(await dca.totalShares()).to.equal(40_000);
        await dca.setDCARouter(xaumDCARouter);

        // convert
        await dollar.transfer(dca.target, 40_000); // dollar amount per share double here
        let calldata = iface.encodeFunctionData("swap", [10_000]);
        await minter.connect(priceOperator).setFixedPrice(_price(_midPrice), 300000);
        await minter.setUSD(usdt, true);
        await expect(dca.connect(operator).executeOrder(0, fakeSwap.target, calldata)).to.emit(dca, 'XaumConvert')
            .withArgs(alice.address, 0, 10_000, 10_000, 5_000, 0); //event XaumConvert(address indexed user, uint64 id, uint dollarDelta, uint stableTokenDelta, uint xaumAmountOut);
        order = await dca.getOrder(0);
        expect(order.dollarBalance).to.equal(20_000 - 10_000);
        expect(order.xaumPending).to.equal(5_000);
        expect(order.dollarShareBalance).to.equal(15_000);
        expect(await dca.totalShares()).to.equal(40_000 - 5000);

        // xaum collect
        await xaum.transfer(minter.target, _xaum(100_000_000n));
        await dca.connect(operator).collectXAUm(0);
        order = await dca.getOrder(0);
        expect(order.xaumPending).to.equal(0);
        expect(order.xaumBalance).to.equal(5_000);

        // xaum claim
        await dca.connect(operator).claimAllXAUm(0);
        order = await dca.getOrder(0);
        expect(order.xaumBalance).to.equal(0);
        expect(await xaum.balanceOf(bob.address)).to.equal(5000);
        expect(order.status).to.equal(ORDER_STATUS_ACTIVE);

        // last trade
        await time.increase(3600 * 24);
        calldata = iface.encodeFunctionData("swap", [30_000]);
        await expect(dca.connect(operator).executeOrder(0, fakeSwap.target, calldata)).to.emit(dca, 'XaumConvert')
            .withArgs(alice.address, 0, 30_000, 30_000, 15_000, 0);
        order = await dca.getOrder(0);
        expect(order.dollarBalance).to.equal(0);
        expect(order.xaumPending).to.equal(15_000);
        expect(order.dollarShareBalance).to.equal(0);
        expect(await dca.totalShares()).to.equal(20_000);
        expect(order.status).to.equal(ORDER_STATUS_COMPLETED_WITHOUT_COLLECT);

        // trade revert
        await expect(dca.connect(operator).executeOrder(0, fakeSwap.target, calldata))
            .to.be.revertedWith('DCA_INVALID_ORDER_STATUS');

        // xaum collect
        await dca.connect(operator).collectXAUm(0);
        order = await dca.getOrder(0);
        expect(order.xaumPending).to.equal(0);
        expect(order.xaumBalance).to.equal(15_000);
        expect(order.status).to.equal(ORDER_STATUS_COMPLETED_WITHOUT_CLAIM);
        expect(await dca.totalShares()).to.equal(20_000);

        // collect revert
        await expect(dca.connect(operator).collectXAUm(0))
            .to.be.revertedWith('DCA_INVALID_ORDER_STATUS');

        // get user active order
        let activeOrderCount = await dca.getActiveOrdersLengthByUser(alice.address);
        expect(activeOrderCount).to.equal(2);
        let activeOrders = await dca.getActiveOrdersByUser(alice.address, 0, 2);
        expect(activeOrders[0].id).to.equal(0);
        expect(activeOrders[1].id).to.equal(1);

        // getActiveOrders(uint startIndex, uint pageSize) public view returns (Order[] memory, uint activeOrdersCount)
        [activeOrders, activeOrderCount] = await dca.getActiveOrders(0, 2);
        expect(activeOrderCount).to.equal(2);
        expect(activeOrders[0].id).to.equal(0);
        expect(activeOrders[1].id).to.equal(1);

        // get orders from XAUMDCARouter
        activeOrderCount = await xaumDCARouter.getActiveOrdersLengthByUser(dollar.target, alice.address);
        expect(activeOrderCount).to.equal(2);
        activeOrders = await xaumDCARouter.getActiveOrdersByUser(dollar.target, alice.address, 0, 2);
        expect(activeOrders[0].id).to.equal(0);
        expect(activeOrders[1].id).to.equal(1);

        // xaum claim
        await dca.connect(operator).claimAllXAUm(0);
        order = await dca.getOrder(0);
        expect(order.xaumBalance).to.equal(0);
        expect(await xaum.balanceOf(bob.address)).to.equal(20000);
        expect(order.status).to.equal(ORDER_STATUS_COMPLETED);
        expect(order.xaumPending).to.equal(0);
        expect(order.dollarBalance).to.equal(0);
        expect(order.dollarShareBalance).to.equal(0);
        expect(order.dollarShareInitAmount).to.equal(20_000);

        // collect revert
        await expect(dca.connect(operator).claimAllXAUm(0))
            .to.be.revertedWith('DCA_INVALID_ORDER_STATUS');

        // get user active order
        activeOrderCount = await dca.getActiveOrdersLengthByUser(alice.address);
        expect(activeOrderCount).to.equal(1);
    });

    it("privileged ops", async function () {
        const {dca, usdt, xaum, alice, bob} = await loadFixture(deployTestFixture);

        const sender = dca.connect(alice);
        const testCases = [
            [sender.setDelay(123)                      , 'OwnableUnauthorizedAccount'],
            [sender.setOperator(alice)                 , 'OwnableUnauthorizedAccount'],
            [sender.setRevoker(alice)                  , 'OwnableUnauthorizedAccount'],
            [sender.setFee(0xfee)                      , 'OwnableUnauthorizedAccount'],
            [sender.setDCARouter(xaum)                 , 'OwnableUnauthorizedAccount'],
            [sender.setLegalAccount(alice)             , 'OwnableUnauthorizedAccount'],
            [sender.setMinDollarPriceAllowed(123)      , 'OwnableUnauthorizedAccount'],
            [sender.setMinDollarAmount(123)            , 'OwnableUnauthorizedAccount'],
            [sender.setMinTradeInterval(123)           , 'OwnableUnauthorizedAccount'],
            [sender.setAdapterWhitelist(xaum, true)    , 'OwnableUnauthorizedAccount'],
            [sender.setUserBlacklist(alice, true)      , 'OwnableUnauthorizedAccount'],
            [sender.setPaused(true)                    , 'OwnableUnauthorizedAccount'],
            [sender.withdrawERC20(usdt, alice, 123)    , 'OwnableUnauthorizedAccount'],
            [sender.withdrawERC721(usdt, alice, 123)   , 'OwnableUnauthorizedAccount'],
            [sender.claimFee(alice)                    , 'OwnableUnauthorizedAccount'],
            [sender.createOrder(alice, 1, 2, 3, bob)   , 'DCA_NOT_ROUTER'],
            [sender.closeOrder(alice, 1, bob)          , 'DCA_NOT_ROUTER'],
            [sender.executeOrderAndClaim(1)            , 'DCA_NOT_OPERATOR'],
            [sender.executeOrderAndClaim(1, xaum, "0x"), 'DCA_NOT_OPERATOR'],
            [sender.executeOrder(1)                    , 'DCA_NOT_OPERATOR'],
            [sender.executeOrder(1, xaum, "0x")        , 'DCA_NOT_OPERATOR'],
            [sender.collectXAUm(1)                     , 'DCA_NOT_OPERATOR'],
            [sender.claimAllXAUm(1)                    , 'DCA_NOT_OPERATOR'],
            [sender.closeOrderByOperator(1)            , 'DCA_NOT_OPERATOR'],
        ];

        for (const [op, err] of testCases) {
            if (err.startsWith('DCA_')) {
                await expect(op).to.be.revertedWith(err)
            } else {
                await expect(op).to.be.revertedWithCustomError(dca, err)
                    .withArgs(alice.address);
            }
        }
    });

    it("setters", async function () {
        const {dca, owner, alice} = await loadFixture(deployTestFixture);

        await dca.connect(owner).setLegalAccount(alice.address);
        await dca.connect(owner).setMinDollarAmount(12345);

        expect(await dca.legalAccount()).to.equal(alice.address);
        expect(await dca.minDollarAmount()).to.equal(12345);
    });

    it("withdrawERC20", async function () {
        const {dca, xaum, usdt, alice, bob} = await loadFixture(deployTestFixture);
        await xaum.connect(alice).mint(22222);
        await xaum.connect(alice).transfer(dca, 12345);
        await usdt.connect(alice).transfer(dca, 12345);

        await expect(dca.withdrawERC20(xaum.target, alice.address, 1234))
        .to.changeTokenBalances(xaum, [dca, alice], [-1234, 1234]);
        await expect(dca.withdrawERC20(usdt.target, bob.address, 2345))
        .to.changeTokenBalances(usdt, [dca, bob], [-2345, 2345]);

        // await expect(dca.withdrawERC20(usdt.target, zeroAddr, 111))
        //     .to.be.revertedWithCustomError(dca, 'ZeroTokenRecipient');
    });

    it("withdrawERC721", async function () {
        // TODO
    });

    it("createOrder: EnforcedPause", async function () {
        const {dca, dcaRouter, dollar, alice} = await loadFixture(deployTestFixture);
        await dca.setPaused(true);
        await dollar.connect(alice).approve(dcaRouter, 2000);
        await expect(dcaRouter.connect(alice).createOrder(dollar, 1000, 100, 3, alice))
            .to.be.revertedWithCustomError(dca, 'EnforcedPause');
    });

    it("createOrder: DCA_INVALID_AMOUNT_PER_TRADE", async function () {
        const {dca, dcaRouter, dollar, alice} = await loadFixture(deployTestFixture);
        await dollar.connect(alice).approve(dcaRouter, defaultMintDollarAmount * 2n);
        await expect(dcaRouter.connect(alice).createOrder(dollar, defaultMintDollarAmount * 2n, defaultMintDollarAmount - 1n, 3, alice))
            .to.be.revertedWith('DCA_INVALID_AMOUNT_PER_TRADE');
    });

    it("createOrder: DCA_INVALID_INIT_DOLLAR_AMOUNT", async function () {
        const {dca, dcaRouter, dollar, alice} = await loadFixture(deployTestFixture);
        await dollar.connect(alice).approve(dcaRouter, defaultMintDollarAmount * 2n);
        await expect(dcaRouter.connect(alice).createOrder(dollar, defaultMintDollarAmount - 1n, defaultMintDollarAmount, 3, alice))
            .to.be.revertedWith('DCA_INVALID_INIT_DOLLAR_AMOUNT');
        await expect(dcaRouter.connect(alice).createOrder(dollar, defaultMintDollarAmount + 1n, defaultMintDollarAmount, 3, alice))
            .to.be.revertedWith('DCA_INVALID_INIT_DOLLAR_AMOUNT');
    });

    it("createOrder: DCA_INVALID_TRADE_INTERVAL", async function () {
        const {dca, dcaRouter, dollar, alice} = await loadFixture(deployTestFixture);
        await dca.setMinTradeInterval(3600);
        await dollar.connect(alice).approve(dcaRouter, 5000);
        await expect(dcaRouter.connect(alice).createOrder(dollar, defaultMintDollarAmount * 2n, defaultMintDollarAmount, 300, alice))
            .to.be.revertedWith('DCA_INVALID_TRADE_INTERVAL');
        await expect(dcaRouter.connect(alice).createOrder(dollar, defaultMintDollarAmount * 2n, defaultMintDollarAmount, 3636, alice))
            .to.be.revertedWith('DCA_INVALID_TRADE_INTERVAL');
    });

    it("createOrder: DCA_IN_BLACKLIST", async function () {
        const {dca, dcaRouter, dollar, alice} = await loadFixture(deployTestFixture);
        await dca.setUserBlacklist(alice, true);
        await dollar.connect(alice).approve(dcaRouter, 5000);
        await expect(dcaRouter.connect(alice).createOrder(dollar, defaultMintDollarAmount * 2n, defaultMintDollarAmount, 3, alice))
            .to.be.revertedWith('DCA_IN_BLACKLIST');
    });

    it("createOrder: ok", async function () {
        const {dca, dcaRouter, dollar, alice, bob} = await loadFixture(deployTestFixture);
        const initDollarAmount = defaultMintDollarAmount * 2n;
        const amountPerTrade = defaultMintDollarAmount;
        const interval = 123;
        await dollar.connect(alice).approve(dcaRouter, 5000);
        await expect(dcaRouter.connect(alice).createOrder(dollar, initDollarAmount, amountPerTrade, interval, bob))
            .to.emit(dca, 'NewOrder')
            .withArgs(alice, 0, initDollarAmount, amountPerTrade, interval, bob);
        expect(await dca.orders(0)).to.deep.equal([
            0n, // id
            interval,
            0n, // lastTradeTime
            ORDER_STATUS_ACTIVE,
            initDollarAmount,
            amountPerTrade,
            initDollarAmount, // dollarBalance
            0n, // dollarShareInitAmount
            0n, // dollarShareBalance
            0n, // xaumBalance
            0n, // xaumPending
            alice.address, // owner
            bob.address, // receiver
        ])
    });

    it("executeOrder: DCA_NOT_IN_WHITELIST", async function () {
        const {dca, dcaRouter, dollar, operator, alice} = await loadFixture(deployTestFixture);
        await dollar.connect(alice).approve(dcaRouter, 5000);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 100, 7, alice);
        const calldata = iface.encodeFunctionData("swap", [100]);
        await expect(dca.connect(operator).executeOrder(0, alice, calldata))
            .to.be.revertedWith('DCA_ADAPTER_NOT_IN_WHITELIST');
    });

    it("executeOrder: DCA_INVALID_ORDER_STATUS", async function () {
        const {dca, dollar, usdt, minter, fakeSwap, xaum,
            dcaRouter, priceOperator, operator, alice} = await loadFixture(deployTestFixture);

        // create 4 orders
        await dollar.connect(alice).approve(dcaRouter, 5000);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 100, 7, alice);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 200, 7, alice);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 1000, 7, alice);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 1000, 7, alice);

        // close order#1
        await dcaRouter.connect(alice).closeOrder(dollar, 1, alice);
        expect(await dca.getOrderStatus(1)).to.equal(ORDER_STATUS_CANCELED);
        const calldata = iface.encodeFunctionData("swap", [1000]);
        await expect(dca.connect(operator).executeOrder(1, fakeSwap, calldata))
            .to.be.revertedWith('DCA_INVALID_ORDER_STATUS');

        // execute order#2
        await minter.setUSD(usdt, true);
        await minter.connect(priceOperator).setFixedPrice(defaultMinPrice, 3600);
        await dca.connect(operator).executeOrder(2, fakeSwap, calldata);
        expect(await dca.getOrderStatus(2)).to.equal(ORDER_STATUS_COMPLETED_WITHOUT_COLLECT);
        await expect(dca.connect(operator).executeOrder(2, fakeSwap, calldata))
            .to.be.revertedWith('DCA_INVALID_ORDER_STATUS');

        // collect order#2
        await xaum.transfer(minter, 10000);
        await dca.connect(operator).collectXAUm(2);
        expect(await dca.getOrderStatus(2)).to.equal(ORDER_STATUS_COMPLETED_WITHOUT_CLAIM);
        await expect(dca.connect(operator).executeOrder(2, fakeSwap, calldata))
            .to.be.revertedWith('DCA_INVALID_ORDER_STATUS');
    });

    it("executeOrder: DCA_NOT_TIME_TO_TRADE", async function () {
        const {dca, dollar, usdt, minter, fakeSwap,
            dcaRouter, priceOperator, operator, alice} = await loadFixture(deployTestFixture);
        await dca.setMinTradeInterval(300);

        // create & execute order
        await dollar.connect(alice).approve(dcaRouter, 5000);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 100, 600, alice);
        await minter.setUSD(usdt, true);
        await minter.connect(priceOperator).setFixedPrice(defaultMinPrice, 3600);
        const calldata = iface.encodeFunctionData("swap", [100]);
        await dca.connect(operator).executeOrder(0, fakeSwap, calldata);

        await expect(dca.connect(operator).executeOrder(0, fakeSwap, calldata))
            .to.be.revertedWith('DCA_NOT_TIME_TO_TRADE');
    });

    it("executeOrder (dollar=stable): DCA_DOLLAR_MUST_BE_STABLE_TOKEN", async function () {
        const {dca, operator} = await loadFixture(deployTestFixture);

        await expect(dca.connect(operator).executeOrder(1))
            .to.be.revertedWith('DCA_DOLLAR_MUST_BE_STABLE_TOKEN');
        await expect(dca.connect(operator).executeOrderAndClaim(2))
            .to.be.revertedWith('DCA_DOLLAR_MUST_BE_STABLE_TOKEN');
    });

    it("executeOrder: ok", async function () {
        const {dca, dollar, usdt, minter, fakeSwap,
            dcaRouter, priceOperator, operator, alice} = await loadFixture(deployTestFixture);

        // create order
        await dollar.connect(alice).approve(dcaRouter, 5000);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 500, 7, alice);

        // execute order
        await minter.setUSD(usdt, true);
        await minter.connect(priceOperator).setFixedPrice(defaultMinPrice, 3600);
        const calldata = iface.encodeFunctionData("swap", [500]);
        await dca.connect(operator).executeOrder(0, fakeSwap, calldata);

        // complete order
        await time.increase(10);
        const calldata2 = iface.encodeFunctionData("swap", [500]);
        await dca.connect(operator).executeOrder(0, fakeSwap, calldata2);
    });

    it("executeOrder: trade amount", async function () {
        const {dca, dollar, usdt, minter, fakeSwap,
            dcaRouter, priceOperator, operator, alice} = await loadFixture(deployTestFixture);
        await minter.setUSD(usdt, true);
        await minter.connect(priceOperator).setFixedPrice(defaultMinPrice, 3600);

        // create order
        await dollar.connect(alice).approve(dcaRouter, 5000);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 200, 7, alice);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 200, 7, alice);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 200, 7, alice);

        // execute orders

        const calldata = iface.encodeFunctionData("swap", [190]); // < 200
        await dca.connect(operator).executeOrder(0, fakeSwap, calldata); // ok

        const calldata1 = iface.encodeFunctionData("swap", [230]); // > 200
        await expect(dca.connect(operator).executeOrder(1, fakeSwap, calldata1))
            .to.be.reverted;

        const calldata2 = iface.encodeFunctionData("swap", [210]); // > 200
        await dca.connect(operator).executeOrder(2, fakeSwap, calldata2); // ok

        // check dollarBalance
        expect((await dca.orders(0))[6]).to.equal(810);
        expect((await dca.orders(1))[6]).to.equal(1000);
        expect((await dca.orders(2))[6]).to.equal(790);
    });

    it("collectXAUm: DCA_INVALID_ORDER_STATUS", async function () {
        const {dca, minter, dollar, usdt, xaum, fakeSwap,
            dcaRouter, priceOperator, operator, alice} = await loadFixture(deployTestFixture);

        // create 3 orders
        await dollar.connect(alice).approve(dcaRouter, 5000);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 100, 7, alice);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 1000, 7, alice);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 200, 7, alice);

        // close order#0
        await dcaRouter.connect(alice).closeOrder(dollar, 0, alice);
        expect(await dca.getOrderStatus(0)).to.equal(ORDER_STATUS_CANCELED);
        await expect(dca.connect(operator).collectXAUm(0))
            .to.be.revertedWith('DCA_INVALID_ORDER_STATUS');

        // execute & collect order#1
        await minter.setUSD(usdt, true);
        await minter.connect(priceOperator).setFixedPrice(defaultMinPrice, 3600);
        const calldata = iface.encodeFunctionData("swap", [1000]);
        await dca.connect(operator).executeOrder(1, fakeSwap, calldata);
        expect(await dca.getOrderStatus(1)).to.equal(ORDER_STATUS_COMPLETED_WITHOUT_COLLECT);
        await xaum.transfer(minter, 10000);
        await dca.connect(operator).collectXAUm(1); // ok
        expect(await dca.getOrderStatus(1)).to.equal(ORDER_STATUS_COMPLETED_WITHOUT_CLAIM);
        await expect(dca.connect(operator).collectXAUm(1))
            .to.be.revertedWith('DCA_INVALID_ORDER_STATUS');

        // finish order#1
        await dca.connect(operator).claimAllXAUm(1);
        expect(await dca.getOrderStatus(1)).to.equal(ORDER_STATUS_COMPLETED);
        await expect(dca.connect(operator).collectXAUm(1))
            .to.be.revertedWith('DCA_INVALID_ORDER_STATUS');
    });

    it("collectXAUm: DCA_INVALID_PENDING_XAUM_AMOUNT", async function () {
        const {dca, dcaRouter, dollar, operator, alice} = await loadFixture(deployTestFixture);

        await dollar.connect(alice).approve(dcaRouter, 1000);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 100, 7, alice);
        await expect(dca.connect(operator).collectXAUm(0))
            .to.be.revertedWith('DCA_INVALID_PENDING_XAUM_AMOUNT');
    });

    it("collectXAUm: ok", async function () {
        const {dca, dcaRouter, usdt, dollar, xaum, minter, fakeSwap,
            priceOperator, operator, alice} = await loadFixture(deployTestFixture);

        // cerate & execute order
        await dollar.connect(alice).approve(dcaRouter, 5000);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 500, 7, alice);
        await minter.setUSD(usdt, true);
        await minter.connect(priceOperator).setFixedPrice(defaultMinPrice, 3600);
        const calldata = iface.encodeFunctionData("swap", [500]);
        await dca.connect(operator).executeOrder(0, fakeSwap, calldata);

        // collect
        await xaum.transfer(minter, 10000);
        const tx = dca.connect(operator).collectXAUm(0);
        await expect(tx).to.changeTokenBalances(xaum, [minter, dca], [-500, 500]);
        await expect(tx).to.emit(dca, 'XaumCollect').withArgs(alice, 0, 500);
    });

    it("claimAllXAUm: DCA_INVALID_XAUM_BALANCE", async function () {
        const {dca, dcaRouter, dollar, operator, alice} = await loadFixture(deployTestFixture);

        await dollar.connect(alice).approve(dcaRouter, 1000);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 500, 7, alice);
        await expect(dca.connect(operator).claimAllXAUm(0))
            .to.be.revertedWith('DCA_INVALID_XAUM_BALANCE');
    });

    it("claimAllXAUm: DCA_IN_BLACKLIST", async function () {
        const {dca, dcaRouter, usdt, dollar, xaum, minter, fakeSwap,
            priceOperator, operator, alice, bob} = await loadFixture(deployTestFixture);

        // cerate, execute & collect order
        await dollar.connect(alice).approve(dcaRouter, 1000);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 500, 7, bob);
        await minter.setUSD(usdt, true);
        await minter.connect(priceOperator).setFixedPrice(defaultMinPrice, 3600);
        const calldata = iface.encodeFunctionData("swap", [500]);
        await dca.connect(operator).executeOrder(0, fakeSwap, calldata);
        await xaum.transfer(minter, 10000);
        await dca.connect(operator).collectXAUm(0);

        await dca.setUserBlacklist(alice, true);
        await expect(dca.connect(operator).claimAllXAUm(0))
            .to.be.revertedWith('DCA_IN_BLACKLIST');

        await dca.setUserBlacklist(alice, false);
        await dca.setUserBlacklist(bob, true);
        await expect(dca.connect(operator).claimAllXAUm(0))
            .to.be.revertedWith('DCA_IN_BLACKLIST');
    });

    it("claimAllXAUm: DCA_INVALID_ORDER_STATUS", async function () {
        const {dca, minter, dollar, usdt, xaum, fakeSwap,
            dcaRouter, priceOperator, operator, alice} = await loadFixture(deployTestFixture);

        // create 3 orders
        await dollar.connect(alice).approve(dcaRouter, 5000);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 100, 7, alice);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 1000, 7, alice);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 200, 7, alice);

        // close order#0
        await dcaRouter.connect(alice).closeOrder(dollar, 0, alice);
        expect(await dca.getOrderStatus(0)).to.equal(ORDER_STATUS_CANCELED);
        await expect(dca.connect(operator).claimAllXAUm(0))
            .to.be.revertedWith('DCA_INVALID_ORDER_STATUS');

        // finish order#1
        await minter.setUSD(usdt, true);
        await minter.connect(priceOperator).setFixedPrice(defaultMinPrice, 3600);
        const calldata = iface.encodeFunctionData("swap", [1000]);
        await dca.connect(operator).executeOrder(1, fakeSwap, calldata);
        await xaum.transfer(minter, 10000);
        await dca.connect(operator).collectXAUm(1); // ok
        await dca.connect(operator).claimAllXAUm(1);
        expect(await dca.getOrderStatus(1)).to.equal(ORDER_STATUS_COMPLETED);
        await expect(dca.connect(operator).claimAllXAUm(1))
            .to.be.revertedWith('DCA_INVALID_ORDER_STATUS');
    });

    it("claimAllXAUm: ok (ORDER_STATUS_ACTIVE)", async function () {
        const {dca, dcaRouter, usdt, dollar, xaum, minter, fakeSwap,
            priceOperator, operator, alice, bob} = await loadFixture(deployTestFixture);

        // cerate, execute & collect order
        await dollar.connect(alice).approve(dcaRouter, 1000);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 500, 7, bob);
        await minter.setUSD(usdt, true);
        await minter.connect(priceOperator).setFixedPrice(defaultMinPrice, 3600);
        const calldata = iface.encodeFunctionData("swap", [500]);
        await dca.connect(operator).executeOrder(0, fakeSwap, calldata);
        await xaum.transfer(minter, 10000);
        await dca.connect(operator).collectXAUm(0);
        expect(await dca.getOrderStatus(0)).to.equal(ORDER_STATUS_ACTIVE);

        const tx = dca.connect(operator).claimAllXAUm(0);
        await expect(tx).to.changeTokenBalances(xaum, [dca, bob], [-500, 500]);
        await expect(tx).to.emit(dca, 'XAUmClaimByOperator')
            .withArgs(alice, 0, 500, bob, false);
    });

    it("claimAllXAUm: ok (ORDER_STATUS_COMPLETED_WITHOUT_COLLECT)", async function () {
        const {dca, dcaRouter, usdt, dollar, xaum, minter, fakeSwap,
            priceOperator, operator, alice, bob} = await loadFixture(deployTestFixture);
        await minter.setUSD(usdt, true);
        await xaum.transfer(minter, 10000);
        await minter.connect(priceOperator).setFixedPrice(defaultMinPrice, 3600);
        const calldata = iface.encodeFunctionData("swap", [500]);

        // prepare order
        await dollar.connect(alice).approve(dcaRouter, 1000);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 500, 60, bob);
        await dca.connect(operator).executeOrder(0, fakeSwap, calldata);
        await dca.connect(operator).collectXAUm(0);
        await time.increase(60);
        await dca.connect(operator).executeOrder(0, fakeSwap, calldata);
        expect(await dca.getOrderStatus(0)).to.equal(ORDER_STATUS_COMPLETED_WITHOUT_COLLECT);

        await expect(dca.connect(operator).claimAllXAUm(0))
            .to.be.revertedWith('DCA_INVALID_ORDER_STATUS');
    });

    it("claimAllXAUm: Forbidden (ORDER_STATUS_COMPLETED_WITHOUT_CLAIM)", async function () {
        const {dca, dcaRouter, usdt, dollar, xaum, minter, fakeSwap,
            priceOperator, operator, alice, bob} = await loadFixture(deployTestFixture);
        await minter.setUSD(usdt, true);
        await xaum.transfer(minter, 10000);
        await minter.connect(priceOperator).setFixedPrice(defaultMinPrice, 3600);
        const calldata = iface.encodeFunctionData("swap", [500]);
        // prepare order
        await dollar.connect(alice).approve(dcaRouter, 5000);
        await dcaRouter.connect(alice).createOrder(dollar, 500, 500, 60, bob);
        await dca.connect(operator).executeOrder(0, fakeSwap, calldata);
        await dca.connect(operator).collectXAUm(0);
        expect(await dca.getOrderStatus(0)).to.equal(ORDER_STATUS_COMPLETED_WITHOUT_CLAIM);

        const tx = dca.connect(operator).claimAllXAUm(0);
        await expect(tx).to.changeTokenBalances(xaum, [dca, bob], [-500, 500]);
        await expect(tx).to.emit(dca, 'XAUmClaimByOperator')
            .withArgs(alice, 0, 500, bob, true);
    });

    it("executeOrderAndClaim: ok", async function () {
        const {dca, dollar, usdt, minter, fakeSwap, xaum,
            dcaRouter, priceOperator, operator, alice} = await loadFixture(deployTestFixture);
        await minter.setUSD(usdt, true);
        await xaum.transfer(minter, 10000);
        await minter.connect(priceOperator).setFixedPrice(defaultMinPrice, 3600);
        const calldata = iface.encodeFunctionData("swap", [500]);

        // create order
        await dollar.connect(alice).approve(dcaRouter, 5000);
        await dcaRouter.connect(alice).createOrder(dollar, 2000, 500, 7, alice);

        // executeOrderAndClaim
        await dca.connect(operator).executeOrderAndClaim(0, fakeSwap, calldata);
    });

    it("closeOrder: EnforcedPause", async function () {
        const {dca, alice} = await loadFixture(deployTestFixture);
        await dca.setPaused(true);
        await expect(dca.closeOrder(alice, 1, alice))
            .to.be.revertedWithCustomError(dca, 'EnforcedPause');

        await dca.setPaused(false);
        await expect(dca.closeOrder(alice, 1, alice))
            .to.be.revertedWith('DCA_NOT_ROUTER');
    });

    it("closeOrder: DCA_IN_BLACKLIST", async function () {
        const {dca, dcaRouter, dollar, alice, bob} = await loadFixture(deployTestFixture);
        await dca.setUserBlacklist(alice, true);
        await expect(dcaRouter.connect(alice).closeOrder(dollar, 1, bob))
            .to.be.revertedWith('DCA_IN_BLACKLIST');
        await expect(dcaRouter.connect(bob).closeOrder(dollar, 2, alice))
            .to.be.revertedWith('DCA_IN_BLACKLIST');
    });

    it("closeOrder: NOT_ORDER_OWNER", async function () {
        const {dca, dcaRouter, dollar, alice, bob} = await loadFixture(deployTestFixture);
        await dollar.connect(alice).approve(dcaRouter, 1000);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 100, 7, alice);
        await expect(dcaRouter.connect(bob).closeOrder(dollar, 0, alice))
            .to.be.revertedWith('NOT_ORDER_OWNER');
    });

    it("closeOrder: DCA_INVALID_RECEIVER", async function () {
        const {dca, dcaRouter, dollar, alice, bob} = await loadFixture(deployTestFixture);
        await dollar.connect(alice).approve(dcaRouter, 1000);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 100, 7, alice);
        await expect(dcaRouter.connect(alice).closeOrder(dollar, 0, bob))
            .to.be.revertedWith('DCA_INVALID_RECEIVER');
    });

    it("closeOrder: DCA_HAS_PENDING_XAUM", async function () {
        const {dca, minter, dollar, usdt, fakeSwap, dcaRouter,
            priceOperator, operator, alice} = await loadFixture(deployTestFixture);

        // create order
        await dollar.connect(alice).approve(dcaRouter, 1000);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 100, 7, alice);

        // execute order
        await minter.setUSD(usdt, true);
        await minter.connect(priceOperator).setFixedPrice(defaultMinPrice, 3600);
        const calldata = iface.encodeFunctionData("swap", [100]);
        await dca.connect(operator).executeOrder(0, fakeSwap, calldata);

        await expect(dcaRouter.connect(alice).closeOrder(dollar, 0, alice))
            .to.be.revertedWith('DCA_HAS_PENDING_XAUM');
    });

    it("closeOrderByOperator: DCA_NOT_IN_BLACKLIST", async function () {
        const {dca, dcaRouter, dollar, operator, alice} = await loadFixture(deployTestFixture);
        await dollar.connect(alice).approve(dcaRouter, 5000);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 100, 7, alice);
        await expect(dca.connect(operator).closeOrderByOperator(0))
            .to.be.revertedWith('DCA_NOT_IN_BLACKLIST');
    });

    it("closeOrderByOperator: ok", async function () {
        const {dca, dcaRouter, dollar, operator, legalAccount, alice} = await loadFixture(deployTestFixture);
        await dollar.connect(alice).approve(dcaRouter, 5000);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 100, 7, alice);
        await dca.setUserBlacklist(alice, true);
        await expect(dca.connect(operator).closeOrderByOperator(0))
            .changeTokenBalances(dollar, [dca, legalAccount], [-1000, 1000]);
    });

    it("closeOrder: DCA_INVALID_ORDER_STATUS", async function () {
        const {dca, minter, dollar, usdt, xaum, fakeSwap,
            dcaRouter, priceOperator, operator, alice} = await loadFixture(deployTestFixture);

        // create 2 orders
        await dollar.connect(alice).approve(dcaRouter, 5000);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 100, 7, alice);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 1000, 7, alice);

        // close order#0
        await dcaRouter.connect(alice).closeOrder(dollar, 0, alice);
        expect(await dca.getOrderStatus(0)).to.equal(ORDER_STATUS_CANCELED);
        await expect(dcaRouter.connect(alice).closeOrder(dollar, 0, alice))
            .to.be.revertedWith('DCA_INVALID_ORDER_STATUS');

        // complete order#1
        await minter.setUSD(usdt, true);
        await minter.connect(priceOperator).setFixedPrice(defaultMinPrice, 3600);
        const calldata = iface.encodeFunctionData("swap", [1000]);
        await dca.connect(operator).executeOrder(1, fakeSwap, calldata);
        expect(await dca.getOrderStatus(1)).to.equal(ORDER_STATUS_COMPLETED_WITHOUT_COLLECT);
        await xaum.transfer(minter, 10000);
        await dca.connect(operator).collectXAUm(1);
        expect(await dca.getOrderStatus(1)).to.equal(ORDER_STATUS_COMPLETED_WITHOUT_CLAIM);
        await dca.connect(operator).claimAllXAUm(1);
        expect(await dca.getOrderStatus(1)).to.equal(ORDER_STATUS_COMPLETED);
        await expect(dcaRouter.connect(alice).closeOrder(dollar, 1, alice))
            .to.be.revertedWith('DCA_INVALID_ORDER_STATUS');
    });

    it("closeOrder: ok", async function () {
        const {dca, minter, dollar, usdt, xaum, fakeSwap, dcaRouter,
            priceOperator, operator, alice} = await loadFixture(deployTestFixture);

        // create & execute order
        await dollar.connect(alice).approve(dcaRouter, 2000);
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 100, 7, alice);
        await minter.setUSD(usdt, true);
        await minter.connect(priceOperator).setFixedPrice(defaultMinPrice, 3600);
        const calldata = iface.encodeFunctionData("swap", [100]);
        const execTx = await dca.connect(operator).executeOrder(0, fakeSwap, calldata);
        const execTs = await getTS(execTx);
        await xaum.transfer(minter, 10000);
        await dca.connect(operator).collectXAUm(0);

        expect(await dca.getOrder(0)).to.deep.equal([
            0n, // id
            7n, // interval
            execTs, // lastTradeTime
            ORDER_STATUS_ACTIVE, // status
            1000n, // dollarInitBalance
            100n, // dollarPerTrade
            900n, // dollarBalance
            0n, // dollarShareInitAmount
            0n, // dollarShareBalance
            100n, // xaumBalance
            0n, // xaumPending
            alice.address, // owner
            alice.address, // receiver
        ]);

        const closeTx = dcaRouter.connect(alice).closeOrder(dollar, 0, alice);
        await expect(closeTx).to.changeTokenBalances(dollar, [dca, alice], [-900n, 900n]);
        await expect(closeTx).to.changeTokenBalances(xaum, [dca, alice], [-100n, 100n]);
        await expect(closeTx).to.emit(dca, 'CloseOrder')
            .withArgs(alice, 0, alice, 100n, 900n);

        expect(await dca.getOrder(0)).to.deep.equal([
            0n, // id
            7n, // interval
            execTs, // lastTradeTime
            ORDER_STATUS_CANCELED, // status
            1000n, // dollarInitBalance
            100n, // dollarPerTrade
            0n, // dollarBalance
            0n, // dollarShareInitAmount
            0n, // dollarShareBalance
            0n, // xaumBalance
            0n, // xaumPending
            alice.address, // owner
            alice.address, // receiver
        ]);
    });

    it("closeOrder: userOrders", async function () {
        const {dca, dollar, dcaRouter, alice, bob} = await loadFixture(deployTestFixture);
        await dollar.connect(alice).approve(dcaRouter, 80000);

        // create orders
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 100, 7, bob);
        await dcaRouter.connect(alice).createOrder(dollar, 2000, 100, 7, bob);
        await dcaRouter.connect(alice).createOrder(dollar, 3000, 100, 7, bob);
        await dcaRouter.connect(alice).createOrder(dollar, 4000, 100, 7, bob);
        await dcaRouter.connect(alice).createOrder(dollar, 5000, 100, 7, bob);
        expect(await dca.getUserOrderIds(alice)).to.deep.equal([ 0n, 1n, 2n, 3n, 4n ]);

        await dcaRouter.connect(alice).closeOrder(dollar, 0, alice);
        expect(await dca.getUserOrderIds(alice)).to.deep.equal([ 4n, 1n, 2n, 3n ]);

        await dcaRouter.connect(alice).closeOrder(dollar, 1, bob);
        expect(await dca.getUserOrderIds(alice)).to.deep.equal([ 4n, 3n, 2n ]);

        await dcaRouter.connect(alice).closeOrder(dollar, 2, alice);
        expect(await dca.getUserOrderIds(alice)).to.deep.equal([ 4n, 3n ]);

        await dcaRouter.connect(alice).closeOrder(dollar, 4, bob);
        expect(await dca.getUserOrderIds(alice)).to.deep.equal([ 3n ]);

        await dcaRouter.connect(alice).closeOrder(dollar, 3, alice);
        expect(await dca.getUserOrderIds(alice)).to.deep.equal([ ]);
    });

    it("claimFee: ok", async function () {
        const {dca, minter, dollar, usdt, dcaRouter, fakeSwap,
            priceOperator, operator, alice, bob} = await loadFixture(deployTestFixture);
        await dca.setFee(200);
        await minter.setUSD(usdt, true);

        // create & execute order
        await dollar.connect(alice).approve(dcaRouter, 20000);
        await dcaRouter.connect(alice).createOrder(dollar, 2000, 1000, 7, alice);
        await minter.connect(priceOperator).setFixedPrice(defaultMinPrice, 3600);
        const calldata = iface.encodeFunctionData("swap", [1000]);
        await dca.connect(operator).executeOrder(0, fakeSwap, calldata);
        expect(await dca.feeToClaim()).to.equal(200);

        await expect(dca.claimFee(bob))
            .to.changeTokenBalances(usdt, [dca, bob], [-200, 200]);
    });

    it("getActiveOrdersByUser", async function () {
        const {dca, dollar, dcaRouter, alice, bob} = await loadFixture(deployTestFixture);
        await dollar.connect(alice).approve(dcaRouter, 80000);
        await dollar.connect(bob).mint(80000);
        await dollar.connect(bob).approve(dcaRouter, 80000);

        // create orders
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 100, 7, alice);
        await dcaRouter.connect(alice).createOrder(dollar, 2000, 100, 7, alice);
        await dcaRouter.connect(alice).createOrder(dollar, 3000, 100, 7, alice);
        await dcaRouter.connect(alice).createOrder(dollar, 4000, 100, 7, alice);
        await dcaRouter.connect(alice).createOrder(dollar, 5000, 100, 7, alice);
        await dcaRouter.connect(alice).createOrder(dollar, 6000, 100, 7, alice);
        await dcaRouter.connect(alice).createOrder(dollar, 7000, 100, 7, alice);
        await dcaRouter.connect(alice).createOrder(dollar, 8000, 100, 7, alice);
        await dcaRouter.connect(alice).closeOrder(dollar, 3, alice);
        await dcaRouter.connect(bob).createOrder(dollar, 9000, 100, 7, bob);
        await dcaRouter.connect(alice).createOrder(dollar, 9000, 100, 7, alice);
        expect(await dca.getOrdersLength()).to.equal(10);
        expect(await dca.getUserOrderIds(alice)).to.deep.equal([ 0n, 1n, 2n, 7n, 4n, 5n, 6n, 9n ]);

        expect((await dcaRouter.getActiveOrdersByUser(dollar, alice, 0, 3)).map(x => x[0]))
            .to.deep.equal([0n, 1n, 2n]);
        expect((await dcaRouter.getActiveOrdersByUser(dollar, alice, 2, 5)).map(x => x[0]))
            .to.deep.equal([2n, 7n, 4n, 5n, 6n]);
        expect((await dcaRouter.getActiveOrdersByUser(dollar, alice, 5, 5)).map(x => x[0]))
            .to.deep.equal([5n, 6n, 9n, 0n, 0n]);
        expect((await dcaRouter.getActiveOrdersByUser(dollar, alice, 9, 5)).map(x => x[0]))
            .to.deep.equal([0n, 0n, 0n, 0n, 0n]);
    });

    it("getActiveOrders", async function () {
        const {dca, dollar, dcaRouter, alice, bob, operator} = await loadFixture(deployTestFixture);
        await dollar.connect(alice).approve(dcaRouter, 80000);
        await dollar.connect(bob).mint(80000);
        await dollar.connect(bob).approve(dcaRouter, 80000);
        await dollar.connect(operator).mint(80000);
        await dollar.connect(operator).approve(dcaRouter, 80000);

        // create orders
        await dcaRouter.connect(alice).createOrder(dollar, 1000, 100, 7, alice);
        await dcaRouter.connect(bob).createOrder(dollar, 2000, 100, 7, bob);
        await dcaRouter.connect(alice).createOrder(dollar, 3000, 100, 7, alice);
        await dcaRouter.connect(bob).createOrder(dollar, 4000, 100, 7, bob);
        await dcaRouter.connect(alice).createOrder(dollar, 5000, 100, 7, alice);
        await dcaRouter.connect(alice).closeOrder(dollar, 4, alice);
        await dcaRouter.connect(operator).createOrder(dollar, 6000, 100, 7, operator);
        await dcaRouter.connect(alice).createOrder(dollar, 7000, 100, 7, alice);
        await dcaRouter.connect(operator).createOrder(dollar, 8000, 100, 7, operator);
        await dcaRouter.connect(bob).createOrder(dollar, 9000, 100, 7, bob);
        expect(await dca.getUserOrderIds(alice)).to.deep.equal([ 0n, 2n, 6n ]);
        expect(await dca.getUserOrderIds(bob)).to.deep.equal([ 1n, 3n, 8n ]);
        expect(await dca.getUserOrderIds(operator)).to.deep.equal([ 5n, 7n ]);

        expect(await dcaRouter.getOrdersLength(dollar)).to.equal(9);
        expect(await dca.getOrdersLength()).to.equal(9);

        expect(await dcaRouter.getActiveOrders(dollar, 0, 3).then(([a, b]) => [a.map(x => x[0]), b]))
            .to.deep.equal([[0n, 1n, 2n], 3n]);
        expect(await dcaRouter.getActiveOrders(dollar, 1, 4).then(([a, b]) => [a.map(x => x[0]), b]))
            .to.deep.equal([[ 1n, 2n, 3n, 0n ], 3n]);
        expect(await dcaRouter.getActiveOrders(dollar, 2, 5).then(([a, b]) => [a.map(x => x[0]), b]))
            .to.deep.equal([[ 2n, 3n, 5n, 6n, 0n ], 4n]);
        expect(await dcaRouter.getActiveOrders(dollar, 3, 6).then(([a, b]) => [a.map(x => x[0]), b]))
            .to.deep.equal([[ 3n, 5n, 6n, 7n, 8n, 0n ], 5n]);
        expect(await dcaRouter.getActiveOrders(dollar, 5, 7).then(([a, b]) => [a.map(x => x[0]), b]))
            .to.deep.equal([[ 5n, 6n, 7n, 8n, 0n, 0n, 0n ], 4n]);
    });

    it("getTotalFee", async function () {
        const {dca, dcaRouter, dollar, usdt} = await loadFixture(deployTestFixture);
        await dca.setFee(50);
        expect(await dca.getTotalFee(100000, 2000)).to.equal(2500);
        expect(await dcaRouter.getTotalFee(dollar, 100000, 2000)).to.equal(2500);
        await expect(dcaRouter.getTotalFee(usdt, 100000, 2000))
            .to.be.revertedWith('DCA_ROUTER_DOLLAR_DCA_NOT_EXIST');
    });

    for (const cName of ["dca", "minter"]) {
        describe("upgrade: " + cName, function () {

            it("request/revoke", async function() {
                const {dca, minter, owner, alice, bob} = await loadFixture(deployTestFixture);
                const _c = cName == "dca" ? dca : minter;
                const delay = Number(await _c.delay());
                expect(delay).to.greaterThan(0);
                await _c.setRevoker(bob.address);
                await time.increase(delay);
                await _c.setRevoker(bob.address);

                await expect(_c.connect(alice).requestUpgradeToAndCall(bob.address, "0xb0b0"))
                    .to.be.revertedWithCustomError(_c, "OwnableUnauthorizedAccount")
                    .withArgs(alice.address);

                if (cName == "dca") {
                    await expect(_c.connect(alice).revokeNextUpgrade())
                        .to.be.revertedWith("DCA_NOT_REVOKER");
                } else {
                    await expect(_c.connect(alice).revokeNextUpgrade())
                        .to.be.revertedWithCustomError(_c, "NotRevoker")
                        .withArgs(alice.address);
                }

                await expect(_c.connect(owner).requestUpgradeToAndCall(bob.address, "0xb0b0"))
                    .to.emit(_c, "UpgradeToAndCallRequest")
                    .withArgs(bob.address, "0xb0b0");
                expect(await _c.nextImplementation()).to.equal(bob.address);
                expect(await _c.nextUpgradeToAndCallDataHash()).to.equal(ethers.keccak256("0xb0b0"));
                expect(await _c.etNextUpgradeToAndCall()).to.gt(0);

                const tx = await _c.connect(owner).requestUpgradeToAndCall(alice.address, "0xa1ce");
                const ts = await getTS(tx);
                expect(await _c.nextImplementation()).to.equal(alice.address);
                expect(await _c.nextUpgradeToAndCallDataHash()).to.equal(ethers.keccak256("0xa1ce"));
                expect(await _c.etNextUpgradeToAndCall()).to.equal(ts + delay);

                await _c.connect(bob).revokeNextUpgrade();
                expect(await _c.etNextUpgradeToAndCall()).to.equal(0);
            });

            it("upgradeToAndCall", async function() {
                const {dca, minter, owner, alice, bob} = await loadFixture(deployTestFixture);
                const _c = cName == "dca" ? dca : minter;
                const delay = await _c.delay();
                await _c.setRevoker(bob.address);
                await time.increase(delay);
                await _c.setRevoker(bob.address);

                const NFTv2 = await ethers.getContractFactory("BullionEnumerableNFT_UT2");
                const nft2impl = await NFTv2.deploy();
                await _c.connect(owner).requestUpgradeToAndCall(nft2impl.target, "0x");

                await expect(_c.connect(owner).upgradeToAndCall(bob.address, "0x"))
                    .to.be.revertedWithCustomError(_c, "InvalidUpgradeToAndCallImpl");
                await expect(_c.connect(owner).upgradeToAndCall(nft2impl.target, "0x1234"))
                    .to.be.revertedWithCustomError(_c, "InvalidUpgradeToAndCallData");
                await expect(_c.connect(owner).upgradeToAndCall(nft2impl.target, "0x"))
                    .to.be.revertedWithCustomError(_c, "TooEarlyToUpgradeToAndCall");

                await time.increase(delay);
                await expect(_c.connect(alice).upgradeToAndCall(nft2impl.target, "0x"))
                    .to.be.revertedWithCustomError(_c, "OwnableUnauthorizedAccount")
                    .withArgs(alice.address);

                await _c.connect(bob).revokeNextUpgrade();
                expect(await _c.etNextUpgradeToAndCall()).to.equal(0);
                await expect(_c.connect(owner).upgradeToAndCall(nft2impl.target, "0x"))
                    .to.be.revertedWithCustomError(_c, "TooEarlyToUpgradeToAndCall");

                // zeroAddr
                await _c.connect(owner).requestUpgradeToAndCall(zeroAddr, "0x");
                await time.increase(delay);
                await expect(_c.connect(owner).upgradeToAndCall(zeroAddr, "0x"))
                    .to.be.reverted;

                // ok
                await _c.connect(owner).requestUpgradeToAndCall(nft2impl.target, "0x");
                await time.increase(delay);
                await _c.connect(owner).upgradeToAndCall(nft2impl.target, "0x");
                expect(await upgrades.erc1967.getImplementationAddress(_c.target))
                    .to.equal(nft2impl.target);
            });

        });
    }
});
