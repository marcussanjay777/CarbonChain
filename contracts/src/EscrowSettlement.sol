// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IEscrowSettlement } from "./interfaces/IEscrowSettlement.sol";
import { ICarbonCreditNFT } from "./interfaces/ICarbonCreditNFT.sol";
import { ICarbonRegistry } from "./interfaces/ICarbonRegistry.sol";

/**
 * @title EscrowSettlement
 * @notice Custodial escrow for carbon credit purchases with a challenge window.
 * @dev Flow: seller lists -> buyer pays into escrow (credit locked as ESCROWED) ->
 *      after the challenge window (or buyer acceptance) funds go to the seller and the NFT to the buyer.
 *      If the credit is disputed and the dispute is upheld, the registry refunds the buyer 100%.
 */
contract EscrowSettlement is Ownable, ReentrancyGuard, IEscrowSettlement {
    address public registry;
    address public nftContract;
    uint256 public challengeWindow = 1 days;

    struct Escrow {
        uint256 tokenId;
        address buyer;
        address seller;
        uint256 amount;
        EscrowStatus status;
        uint256 releaseAfter;
    }

    mapping(bytes32 => Escrow) public escrows;
    mapping(uint256 => uint256) public listingPrice; // tokenId => price in wei (0 = not listed)
    uint256 private _escrowNonce;

    modifier onlyRegistryOrOwner() {
        require(msg.sender == registry || msg.sender == owner(), "Not registry or owner");
        _;
    }

    constructor() Ownable(msg.sender) {}

    function setRegistry(address _registry) external onlyOwner {
        registry = _registry;
    }

    function setCarbonCreditNFT(address _nftContract) external onlyOwner {
        nftContract = _nftContract;
    }

    function setNFTContract(address _nftContract) external onlyOwner {
        nftContract = _nftContract;
    }

    function setChallengeWindow(uint256 seconds_) external onlyOwner {
        challengeWindow = seconds_;
    }

    // ---------------------------------------------------------------- listing

    /// @notice List a credit for sale. Callable by the token owner or the protocol owner (relayer).
    function listCredit(uint256 tokenId, uint256 priceWei) external override {
        require(priceWei > 0, "Price must be > 0");
        address tokenOwner = IERC721(nftContract).ownerOf(tokenId);
        require(msg.sender == tokenOwner || msg.sender == owner(), "Not token owner");
        require(_isTradable(tokenId), "Credit not tradable");
        listingPrice[tokenId] = priceWei;
        emit CreditListed(tokenId, tokenOwner, priceWei);
    }

    function delistCredit(uint256 tokenId) external override {
        address tokenOwner = IERC721(nftContract).ownerOf(tokenId);
        require(msg.sender == tokenOwner || msg.sender == owner(), "Not token owner");
        delete listingPrice[tokenId];
        emit CreditDelisted(tokenId);
    }

    // ----------------------------------------------------------------- escrow

    function buyWithEscrow(uint256 tokenId) external payable override nonReentrant returns (bytes32 escrowId) {
        require(nftContract != address(0), "NFT contract not configured");
        uint256 price = listingPrice[tokenId];
        require(price > 0, "Credit not listed");
        require(msg.value == price, "Payment must equal listing price");
        require(_isTradable(tokenId), "Credit not tradable");

        address currentOwner = IERC721(nftContract).ownerOf(tokenId);
        require(currentOwner != msg.sender, "Cannot buy own credit");

        _escrowNonce++;
        escrowId = keccak256(abi.encodePacked(block.timestamp, msg.sender, tokenId, _escrowNonce));
        uint256 releaseAfter = block.timestamp + challengeWindow;

        escrows[escrowId] = Escrow({
            tokenId: tokenId,
            buyer: msg.sender,
            seller: currentOwner,
            amount: msg.value,
            status: EscrowStatus.LOCKED,
            releaseAfter: releaseAfter
        });
        delete listingPrice[tokenId];

        ICarbonCreditNFT(nftContract).setCreditStatus(tokenId, ICarbonCreditNFT.CreditStatus.ESCROWED);
        if (registry != address(0)) {
            ICarbonRegistry(registry).registerEscrow(tokenId, escrowId);
        }

        emit EscrowCreated(escrowId, tokenId, msg.sender, currentOwner, msg.value, releaseAfter);
        return escrowId;
    }

    /// @notice Settle the sale. Buyer may accept early; anyone may settle after the challenge window.
    function releaseEscrow(bytes32 escrowId) external override nonReentrant {
        Escrow storage e = escrows[escrowId];
        require(e.status == EscrowStatus.LOCKED, "Escrow not locked");
        require(
            msg.sender == e.buyer || msg.sender == owner() || msg.sender == registry || block.timestamp >= e.releaseAfter,
            "Challenge window still open"
        );
        (, , , , , ICarbonCreditNFT.CreditStatus st) = ICarbonCreditNFT(nftContract).getCreditDetails(e.tokenId);
        require(st == ICarbonCreditNFT.CreditStatus.ESCROWED, "Credit under dispute");

        e.status = EscrowStatus.RELEASED;
        if (registry != address(0)) ICarbonRegistry(registry).clearEscrow(e.tokenId);

        ICarbonCreditNFT(nftContract).escrowTransfer(e.seller, e.buyer, e.tokenId);
        ICarbonCreditNFT(nftContract).setCreditStatus(e.tokenId, ICarbonCreditNFT.CreditStatus.TRANSFERRED);

        (bool sent, ) = payable(e.seller).call{value: e.amount}("");
        require(sent, "Payout to seller failed");

        emit EscrowReleased(escrowId, e.seller, e.amount);
    }

    /// @notice Refund the buyer 100% (called by the registry when a dispute is upheld, or by the owner).
    function refundEscrow(bytes32 escrowId) external override onlyRegistryOrOwner nonReentrant returns (uint256 refunded) {
        Escrow storage e = escrows[escrowId];
        require(e.status == EscrowStatus.LOCKED, "Escrow not locked");

        e.status = EscrowStatus.REFUNDED;
        refunded = e.amount;
        if (registry != address(0)) ICarbonRegistry(registry).clearEscrow(e.tokenId);

        // Only restore the seller's status if the credit is merely escrowed. A disputed/revoked credit keeps its state.
        (, , , , , ICarbonCreditNFT.CreditStatus st) = ICarbonCreditNFT(nftContract).getCreditDetails(e.tokenId);
        if (st == ICarbonCreditNFT.CreditStatus.ESCROWED) {
            ICarbonCreditNFT(nftContract).setCreditStatus(e.tokenId, ICarbonCreditNFT.CreditStatus.ISSUED);
        }

        (bool sent, ) = payable(e.buyer).call{value: refunded}("");
        require(sent, "Refund to buyer failed");

        emit EscrowRefunded(escrowId, e.buyer, refunded);
    }

    function _isTradable(uint256 tokenId) internal view returns (bool) {
        (, , , , , ICarbonCreditNFT.CreditStatus st) = ICarbonCreditNFT(nftContract).getCreditDetails(tokenId);
        return st == ICarbonCreditNFT.CreditStatus.ISSUED || st == ICarbonCreditNFT.CreditStatus.TRANSFERRED;
    }
}
