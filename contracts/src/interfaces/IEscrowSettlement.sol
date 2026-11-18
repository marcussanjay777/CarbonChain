// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IEscrowSettlement {
    enum EscrowStatus { LOCKED, RELEASED, REFUNDED }

    event CreditListed(uint256 indexed tokenId, address indexed seller, uint256 price);
    event CreditDelisted(uint256 indexed tokenId);
    event EscrowCreated(bytes32 indexed escrowId, uint256 indexed tokenId, address indexed buyer, address seller, uint256 amount, uint256 releaseAfter);
    event EscrowReleased(bytes32 indexed escrowId, address seller, uint256 amount);
    event EscrowRefunded(bytes32 indexed escrowId, address buyer, uint256 amount);

    function listCredit(uint256 tokenId, uint256 priceWei) external;
    function delistCredit(uint256 tokenId) external;
    function buyWithEscrow(uint256 tokenId) external payable returns (bytes32 escrowId);
    function releaseEscrow(bytes32 escrowId) external;
    function refundEscrow(bytes32 escrowId) external returns (uint256 refunded);
}
