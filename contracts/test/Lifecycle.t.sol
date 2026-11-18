// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/CarbonCreditNFT.sol";
import "../src/CarbonRegistry.sol";
import "../src/VerifierStakingLedger.sol";
import "../src/EscrowSettlement.sol";

/// @notice End-to-end tests for the full protocol: issuance, escrow trading, disputes, slashing and refunds.
contract LifecycleTest is Test {
    CarbonRegistry registry;
    CarbonCreditNFT nft;
    VerifierStakingLedger ledger;
    EscrowSettlement escrow;

    address treasury = address(0xFEE);
    address issuer = address(0x1111);
    address verifierA = address(0x2222);
    address verifierB = address(0x2223);
    address buyer = address(0x3333);
    address attacker = address(0xBAD);

    bytes32 projectId = keccak256("PROJ-PEATLAND");
    bytes32 bundleId = keccak256("BUNDLE-1");

    function setUp() public {
        registry = new CarbonRegistry();
        nft = new CarbonCreditNFT("Carbonyx", "CARBX");
        ledger = new VerifierStakingLedger();
        escrow = new EscrowSettlement();

        registry.setCarbonCreditNFT(address(nft));
        registry.setVerifierStakingLedger(address(ledger));
        registry.setEscrowSettlement(address(escrow));
        nft.setRegistry(address(registry));
        nft.setEscrowContract(address(escrow));
        ledger.setRegistry(address(registry));
        ledger.setTreasury(treasury);
        escrow.setRegistry(address(registry));
        escrow.setCarbonCreditNFT(address(nft));

        vm.deal(verifierA, 10 ether);
        vm.deal(verifierB, 10 ether);
        vm.deal(buyer, 10 ether);
    }

    // ---------------------------------------------------------------- helpers

    function _issueLowConfidenceCredit() internal returns (uint256 tokenId) {
        registry.registerProjectFor(issuer, projectId, "did:carbonyx:0x1", keccak256("kyc"), 0);
        registry.commitEvidenceBundle(bundleId, projectId, keccak256("root"));
        registry.recordRiskResult(bundleId, true, false, true);

        vm.prank(verifierA);
        ledger.stake{value: 1 ether}();
        vm.prank(verifierB);
        ledger.stake{value: 2 ether}();

        registry.castVerifierVote(bundleId, verifierA, true);
        registry.castVerifierVote(bundleId, verifierB, true);
        registry.finalizeVerification(bundleId, true);

        tokenId = registry.mintCredit(bundleId, 750, 2026);
    }

    function _issueAndEscrow() internal returns (uint256 tokenId, bytes32 escrowId) {
        tokenId = _issueLowConfidenceCredit();
        vm.prank(issuer);
        escrow.listCredit(tokenId, 3 ether);
        vm.prank(buyer);
        escrowId = escrow.buyWithEscrow{value: 3 ether}(tokenId);
    }

    // ------------------------------------------------------------- issuance

    function test_RelayerRegisteredProjectMintsToOwnerNotRelayer() public {
        uint256 tokenId = _issueLowConfidenceCredit();
        assertEq(nft.ownerOf(tokenId), issuer);
    }

    function test_QuorumApprovalRequiresFinalize() public {
        registry.registerProjectFor(issuer, projectId, "did", keccak256("kyc"), 0);
        registry.commitEvidenceBundle(bundleId, projectId, keccak256("root"));
        registry.recordRiskResult(bundleId, true, false, true);
        vm.prank(verifierA);
        ledger.stake{value: 1 ether}();

        registry.castVerifierVote(bundleId, verifierA, true);
        vm.expectRevert(abi.encodeWithSelector(CarbonRegistry.ConfidenceThresholdNotMet.selector, bundleId));
        registry.mintCredit(bundleId, 100, 2026);
    }

    function test_VerifierCannotVoteTwiceOrOnOwnProject() public {
        registry.registerProjectFor(verifierA, projectId, "did", keccak256("kyc"), 0);
        registry.commitEvidenceBundle(bundleId, projectId, keccak256("root"));
        registry.recordRiskResult(bundleId, true, false, true);
        vm.prank(verifierA);
        ledger.stake{value: 1 ether}();
        vm.prank(verifierB);
        ledger.stake{value: 1 ether}();

        vm.expectRevert(abi.encodeWithSelector(CarbonRegistry.VerifierConflict.selector, verifierA));
        registry.castVerifierVote(bundleId, verifierA, true);

        registry.castVerifierVote(bundleId, verifierB, true);
        vm.expectRevert(abi.encodeWithSelector(CarbonRegistry.AlreadyVoted.selector, bundleId, verifierB));
        registry.castVerifierVote(bundleId, verifierB, true);
    }

    // --------------------------------------------------------- access control

    function test_OnlyRelayerCanMintDisputeResolve() public {
        uint256 tokenId = _issueLowConfidenceCredit();

        vm.startPrank(attacker);
        vm.expectRevert(abi.encodeWithSelector(CarbonRegistry.UnauthorizedRelayer.selector, attacker));
        registry.mintCredit(bundleId, 1, 2026);
        vm.expectRevert(abi.encodeWithSelector(CarbonRegistry.UnauthorizedRelayer.selector, attacker));
        registry.disputeCredit(tokenId, "grief");
        vm.expectRevert(abi.encodeWithSelector(CarbonRegistry.UnauthorizedRelayer.selector, attacker));
        registry.resolveDispute(tokenId, true, "x");
        vm.stopPrank();
    }


    function test_CorrelationFailureBlocksMintUnlessQuorumApproves() public {
        registry.registerProjectFor(issuer, projectId, "did", keccak256("kyc"), 0);
        registry.commitEvidenceBundle(bundleId, projectId, keccak256("root"));
        registry.recordRiskResult(bundleId, false, false, true); // IoT vs satellite disagree
        vm.prank(verifierA);
        ledger.stake{value: 1 ether}();

        vm.expectRevert(abi.encodeWithSelector(CarbonRegistry.CorrelationNotMet.selector, bundleId));
        registry.mintCredit(bundleId, 100, 2026);

        registry.castVerifierVote(bundleId, verifierA, true);
        registry.finalizeVerification(bundleId, true);
        assertEq(registry.mintCredit(bundleId, 100, 2026), 1);
    }

    function test_RejectedQuorumCannotMint() public {
        registry.registerProjectFor(issuer, projectId, "did", keccak256("kyc"), 0);
        registry.commitEvidenceBundle(bundleId, projectId, keccak256("root"));
        registry.recordRiskResult(bundleId, false, false, true);
        vm.prank(verifierA);
        ledger.stake{value: 1 ether}();
        registry.castVerifierVote(bundleId, verifierA, false);
        registry.finalizeVerification(bundleId, false);
        vm.expectRevert(abi.encodeWithSelector(CarbonRegistry.CorrelationNotMet.selector, bundleId));
        registry.mintCredit(bundleId, 100, 2026);
    }


    // ------------------------------------------------------------------ escrow

    function test_EscrowBuyRequiresListingAndExactPrice() public {
        uint256 tokenId = _issueLowConfidenceCredit();

        vm.prank(buyer);
        vm.expectRevert("Credit not listed");
        escrow.buyWithEscrow{value: 1 ether}(tokenId);

        vm.prank(issuer);
        escrow.listCredit(tokenId, 3 ether);
        vm.prank(buyer);
        vm.expectRevert("Payment must equal listing price");
        escrow.buyWithEscrow{value: 1 ether}(tokenId);
    }

    function test_EscrowReleaseWaitsForChallengeWindow() public {
        (uint256 tokenId, bytes32 escrowId) = _issueAndEscrow();
        (, , , , ICarbonCreditNFT.CreditStatus st) = _details(tokenId);
        assertTrue(st == ICarbonCreditNFT.CreditStatus.ESCROWED);

        vm.prank(attacker);
        vm.expectRevert("Challenge window still open");
        escrow.releaseEscrow(escrowId);

        vm.warp(block.timestamp + 1 days + 1);
        uint256 before = issuer.balance;
        vm.prank(attacker); // anyone may settle once the window has passed
        escrow.releaseEscrow(escrowId);

        assertEq(issuer.balance, before + 3 ether);
        assertEq(nft.ownerOf(tokenId), buyer);
    }

    function test_BuyerCanAcceptEarly() public {
        (uint256 tokenId, bytes32 escrowId) = _issueAndEscrow();
        vm.prank(buyer);
        escrow.releaseEscrow(escrowId);
        assertEq(nft.ownerOf(tokenId), buyer);
    }

    function test_EscrowedCreditCannotBeTransferredOrRetired() public {
        (uint256 tokenId, ) = _issueAndEscrow();
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(CarbonCreditNFT.TransferLocked.selector, tokenId));
        nft.transferFrom(issuer, attacker, tokenId);

        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(CarbonCreditNFT.CreditNotRetirable.selector, tokenId));
        nft.retireCredit(tokenId, "sneaky");
    }

    // --------------------------------------------- the headline: dispute -> 3-way settlement

    function test_UpheldDisputeRevokesRefundsAndSlashes() public {
        (uint256 tokenId, bytes32 escrowId) = _issueAndEscrow();
        uint256 buyerBefore = buyer.balance; // 7 ether after paying 3

        registry.disputeCreditBy(tokenId, buyer, "Satellite canopy over-claimed by 40%");
        registry.resolveDispute(tokenId, true, "Upheld");

        // (1) revoked
        (, , , , ICarbonCreditNFT.CreditStatus st) = _details(tokenId);
        assertTrue(st == ICarbonCreditNFT.CreditStatus.REVOKED);

        // (2) buyer refunded 100%
        assertEq(buyer.balance, buyerBefore + 3 ether);
        (, , , , IEscrowSettlement.EscrowStatus es, ) = escrow.escrows(escrowId);
        assertTrue(es == IEscrowSettlement.EscrowStatus.REFUNDED);

        // (3) both approving verifiers slashed 50%; funds went to treasury
        (uint256 stakedA, uint256 repA, , uint256 slashedA) = ledger.getVerifierProfile(verifierA);
        (uint256 stakedB, , , uint256 slashedB) = ledger.getVerifierProfile(verifierB);
        assertEq(stakedA, 0.5 ether);
        assertEq(slashedA, 0.5 ether);
        assertEq(stakedB, 1 ether);
        assertEq(slashedB, 1 ether);
        assertEq(treasury.balance, 1.5 ether);
        assertEq(repA, 70); // 100 (+1 capped) then -30 on slash
    }

    function test_RevokedCreditIsDeadForever() public {
        (uint256 tokenId, ) = _issueAndEscrow();
        registry.disputeCreditBy(tokenId, buyer, "fraud");
        registry.resolveDispute(tokenId, true, "Upheld");

        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(CarbonCreditNFT.CreditRevoked.selector, tokenId));
        nft.retireCredit(tokenId, "launder");

        vm.expectRevert(abi.encodeWithSelector(CarbonRegistry.CreditNotDisputable.selector, tokenId));
        registry.disputeCreditBy(tokenId, buyer, "again");
    }

    function test_DismissedDisputeRestoresEscrowedState() public {
        (uint256 tokenId, bytes32 escrowId) = _issueAndEscrow();
        registry.disputeCreditBy(tokenId, buyer, "suspicion");

        // cannot settle while disputed
        vm.prank(buyer);
        vm.expectRevert("Credit under dispute");
        escrow.releaseEscrow(escrowId);

        registry.resolveDispute(tokenId, false, "Dismissed: evidence holds");
        (, , , , ICarbonCreditNFT.CreditStatus st) = _details(tokenId);
        assertTrue(st == ICarbonCreditNFT.CreditStatus.ESCROWED);

        // verifiers untouched
        (uint256 stakedA, , , uint256 slashedA) = ledger.getVerifierProfile(verifierA);
        assertEq(stakedA, 1 ether);
        assertEq(slashedA, 0);

        vm.prank(buyer);
        escrow.releaseEscrow(escrowId);
        assertEq(nft.ownerOf(tokenId), buyer);
    }

    function test_DisputeWithoutEscrowStillSlashes() public {
        uint256 tokenId = _issueLowConfidenceCredit();
        registry.disputeCreditBy(tokenId, attacker, "fraud");
        registry.resolveDispute(tokenId, true, "Upheld");
        (uint256 stakedA, , , ) = ledger.getVerifierProfile(verifierA);
        assertEq(stakedA, 0.5 ether);
    }

    // ------------------------------------------------------ verifier economics

    function test_VerifierCannotWithdrawAfterApproving() public {
        _issueLowConfidenceCredit();
        vm.prank(verifierA);
        vm.expectRevert("Stake locked by recent audit");
        ledger.unstake(1 ether);

        vm.warp(block.timestamp + 31 days);
        vm.prank(verifierA);
        ledger.unstake(1 ether);
    }

    // ------------------------------------------------- Merkle inclusion proof

    function test_MerkleInclusionProofVerifiesOnChain() public {
        bytes32 a = sha256("iot-reading");
        bytes32 b = sha256("satellite-ndvi");
        bytes32 c = sha256("operational-doc");

        bytes32 la = sha256(abi.encodePacked(bytes1(0x00), a));
        bytes32 lb = sha256(abi.encodePacked(bytes1(0x00), b));
        bytes32 lc = sha256(abi.encodePacked(bytes1(0x00), c));
        bytes32 nab = _node(la, lb);
        bytes32 root = _node(nab, lc); // odd leaf is promoted, not duplicated

        registry.registerProjectFor(issuer, projectId, "did", keccak256("kyc"), 0);
        registry.commitEvidenceBundle(bundleId, projectId, root);

        bytes32[] memory proofA = new bytes32[](2);
        proofA[0] = lb;
        proofA[1] = lc;
        assertTrue(registry.verifyEvidenceInclusion(bundleId, a, proofA));

        bytes32[] memory proofC = new bytes32[](1);
        proofC[0] = nab;
        assertTrue(registry.verifyEvidenceInclusion(bundleId, c, proofC));

        // forged payload fails
        assertFalse(registry.verifyEvidenceInclusion(bundleId, sha256("tampered"), proofA));
    }

    function _node(bytes32 x, bytes32 y) internal pure returns (bytes32) {
        return x < y ? sha256(abi.encodePacked(bytes1(0x01), x, y)) : sha256(abi.encodePacked(bytes1(0x01), y, x));
    }

    function _details(uint256 tokenId)
        internal
        view
        returns (bytes32, bytes32, bytes32, uint256, ICarbonCreditNFT.CreditStatus)
    {
        (bytes32 p, bytes32 b, bytes32 r, uint256 t, , ICarbonCreditNFT.CreditStatus s) = nft.getCreditDetails(tokenId);
        return (p, b, r, t, s);
    }
}
