// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract FakeERC721 is ERC721 {

    constructor(string memory symbol) ERC721(symbol, symbol) {
        // empty
    }

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

}
