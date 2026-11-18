// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/ICarbonRegistry.sol";
import "./interfaces/ICarbonCreditNFT.sol";
import "./interfaces/IVerifierStakingLedger.sol";
import "./interfaces/IEscrowSettlement.sol";

/**
 * @title CarbonRegistry
 * @notice Central state machine: project registry -> evidence commitment (Merkle root) -> AI risk gate ->
 *         verifier quorum -> credit issuance -> disputes with automatic revoke / refund / slash.
 */
contract CarbonRegistry is Ownable, ICarbonRegistry {
    uint256 public constant SLASH_PERCENTAGE = 50;

    struct Project {
        bytes32 projectId;
        string did;
        address owner;
        bytes32 kycAttestationHash;
        uint256 baselineChallengeExpiry;
        ProjectStatus status;
        bool exists;
    }

    struct EvidenceBundle {
        bytes32 bundleId;
        bytes32 projectId;
        bytes32 merkleRoot;
        bool isCommitted;
        bool riskEvaluated;
        bool correlationMet;
        bool confidenceMet;
        bool verifierRequired;
        bool verifierApproved;
        address assignedVerifier;
        bool isMinted;
        uint256 mintedTokenId;
    }

    struct CreditRecord {
        uint256 tokenId;
        bytes32 projectId;
        bytes32 bundleId;
        CreditStatus status;
        string disputeReason;
        address disputeInitiator;
        ICarbonCreditNFT.CreditStatus preDisputeStatus;
    }

    enum CreditStatus { ISSUED, ESCROWED, TRANSFERRED, RETIRED, DISPUTED, REVOKED }

    ICarbonCreditNFT public carbonCreditNFT;
    IVerifierStakingLedger public verifierStakingLedger;
    IEscrowSettlement public escrowSettlement;

    mapping(bytes32 => Project) public projects;
    mapping(bytes32 => EvidenceBundle) public evidenceBundles;
    mapping(uint256 => CreditRecord) public credits;
    mapping(bytes32 => address) public bundleVerifiers;
    mapping(uint256 => bytes32) public tokenToEscrow;
    mapping(address => bool) public trustedRelayers;

    mapping(bytes32 => address[]) private _approvers;
    mapping(bytes32 => mapping(address => bool)) public hasVoted;

    error ProjectAlreadyRegistered(bytes32 projectId);
    error ProjectNotActive(bytes32 projectId);
    error BundleAlreadyCommitted(bytes32 bundleId);
    error BundleNotCommitted(bytes32 bundleId);
    error BundleAlreadyMinted(bytes32 bundleId);
    error RiskNotEvaluated(bytes32 bundleId);
    error CorrelationNotMet(bytes32 bundleId);
    error ConfidenceThresholdNotMet(bytes32 bundleId);
    error VerifierApprovalRequired(bytes32 bundleId);
    error InsufficientVerifierStake(address verifier);
    error UnauthorizedRelayer(address caller);
    error UnauthorizedCaller(address caller);
    error InvalidNFTContract();
    error CreditNotInDispute(uint256 tokenId);
    error CreditNotDisputable(uint256 tokenId);
    error AlreadyVoted(bytes32 bundleId, address verifier);
    error VerifierConflict(address verifier);

    modifier onlyRelayerOrOwner() {
        if (!trustedRelayers[msg.sender] && msg.sender != owner()) {
            revert UnauthorizedRelayer(msg.sender);
        }
        _;
    }

    modifier onlyEscrow() {
        if (msg.sender != address(escrowSettlement)) revert UnauthorizedCaller(msg.sender);
        _;
    }

    constructor() Ownable(msg.sender) {
        trustedRelayers[msg.sender] = true;
    }

    // ------------------------------------------------------------------ admin

    function setCarbonCreditNFT(address _nft) external onlyOwner {
        carbonCreditNFT = ICarbonCreditNFT(_nft);
    }

    function setVerifierStakingLedger(address _ledger) external onlyOwner {
        verifierStakingLedger = IVerifierStakingLedger(_ledger);
    }

    function setEscrowSettlement(address _escrow) external onlyOwner {
        escrowSettlement = IEscrowSettlement(_escrow);
    }

    function setTrustedRelayer(address relayer, bool isTrusted) external onlyOwner {
        trustedRelayers[relayer] = isTrusted;
    }

    // --------------------------------------------------------------- projects

    function registerProject(
        bytes32 projectId,
        string calldata did,
        bytes32 kycHash,
        uint256 challengeDuration
    ) external {
        _registerProject(msg.sender, projectId, did, kycHash, challengeDuration);
    }

    /// @notice Relayer registers a project on behalf of its (off-chain authenticated) owner wallet.
    function registerProjectFor(
        address projectOwner,
        bytes32 projectId,
        string calldata did,
        bytes32 kycHash,
        uint256 challengeDuration
    ) external onlyRelayerOrOwner {
        _registerProject(projectOwner, projectId, did, kycHash, challengeDuration);
    }

    function _registerProject(
        address projectOwner,
        bytes32 projectId,
        string calldata did,
        bytes32 kycHash,
        uint256 challengeDuration
    ) internal {
        if (projects[projectId].exists) {
            revert ProjectAlreadyRegistered(projectId);
        }

        projects[projectId] = Project({
            projectId: projectId,
            did: did,
            owner: projectOwner,
            kycAttestationHash: kycHash,
            baselineChallengeExpiry: block.timestamp + challengeDuration,
            status: ProjectStatus.ACTIVE,
            exists: true
        });

        emit ProjectRegistered(projectId, did, projectOwner);
    }

    /// @notice Regulator enforcement: suspend / reactivate a project (suspended projects cannot mint).
    function setProjectStatus(bytes32 projectId, ProjectStatus status) external onlyRelayerOrOwner {
        if (!projects[projectId].exists) revert ProjectNotActive(projectId);
        projects[projectId].status = status;
        emit ProjectStatusChanged(projectId, status);
    }

    // --------------------------------------------------------------- evidence

    function commitEvidenceBundle(
        bytes32 bundleId,
        bytes32 projectId,
        bytes32 merkleRoot
    ) external onlyRelayerOrOwner {
        Project storage project = projects[projectId];
        if (!project.exists || project.status != ProjectStatus.ACTIVE) {
            revert ProjectNotActive(projectId);
        }
        if (evidenceBundles[bundleId].isCommitted) {
            revert BundleAlreadyCommitted(bundleId);
        }

        evidenceBundles[bundleId] = EvidenceBundle({
            bundleId: bundleId,
            projectId: projectId,
            merkleRoot: merkleRoot,
            isCommitted: true,
            riskEvaluated: false,
            correlationMet: false,
            confidenceMet: false,
            verifierRequired: false,
            verifierApproved: false,
            assignedVerifier: address(0),
            isMinted: false,
            mintedTokenId: 0
        });

        emit EvidenceCommitted(bundleId, projectId, merkleRoot);
    }

    function recordRiskResult(
        bytes32 bundleId,
        bool correlationMet,
        bool confidenceMet,
        bool verifierRequired
    ) external onlyRelayerOrOwner {
        EvidenceBundle storage bundle = evidenceBundles[bundleId];
        if (!bundle.isCommitted) {
            revert BundleNotCommitted(bundleId);
        }

        bundle.riskEvaluated = true;
        bundle.correlationMet = correlationMet;
        bundle.confidenceMet = confidenceMet;
        bundle.verifierRequired = verifierRequired;

        emit RiskResultRecorded(bundleId, correlationMet, confidenceMet, verifierRequired);
    }

    /**
     * @notice Verify on-chain that a telemetry payload hash is part of a committed bundle.
     * @dev Mirrors the backend tree: leaf = sha256(0x00 || payloadHash); node = sha256(0x01 || min(a,b) || max(a,b)).
     */
    function verifyEvidenceInclusion(
        bytes32 bundleId,
        bytes32 payloadHash,
        bytes32[] calldata proof
    ) external view returns (bool) {
        EvidenceBundle storage bundle = evidenceBundles[bundleId];
        if (!bundle.isCommitted) return false;

        bytes32 node = sha256(abi.encodePacked(bytes1(0x00), payloadHash));
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 sibling = proof[i];
            node = node < sibling
                ? sha256(abi.encodePacked(bytes1(0x01), node, sibling))
                : sha256(abi.encodePacked(bytes1(0x01), sibling, node));
        }
        return node == bundle.merkleRoot;
    }

    // ------------------------------------------------------------- verifiers

    /// @notice Single-verifier shortcut: the staked caller votes and the bundle is finalized immediately.
    function recordVerification(bytes32 bundleId, bool approved) external {
        _vote(bundleId, msg.sender, approved);
        evidenceBundles[bundleId].verifierApproved = approved;
        emit VerificationFinalized(bundleId, approved);
    }

    /// @notice Relayer records a vote for a staked verifier whose decision was authenticated off-chain.
    function castVerifierVote(bytes32 bundleId, address verifier, bool approved) external onlyRelayerOrOwner {
        _vote(bundleId, verifier, approved);
    }

    /// @notice Relayer finalizes the quorum outcome for a bundle.
    function finalizeVerification(bytes32 bundleId, bool approved) external onlyRelayerOrOwner {
        EvidenceBundle storage bundle = evidenceBundles[bundleId];
        if (!bundle.isCommitted) revert BundleNotCommitted(bundleId);
        if (!bundle.verifierRequired) revert UnauthorizedCaller(msg.sender);
        bundle.verifierApproved = approved;
        emit VerificationFinalized(bundleId, approved);
    }

    function _vote(bytes32 bundleId, address verifier, bool approved) internal {
        EvidenceBundle storage bundle = evidenceBundles[bundleId];
        if (!bundle.isCommitted) {
            revert BundleNotCommitted(bundleId);
        }
        if (!bundle.verifierRequired) {
            revert UnauthorizedCaller(verifier);
        }
        if (hasVoted[bundleId][verifier]) {
            revert AlreadyVoted(bundleId, verifier);
        }
        if (projects[bundle.projectId].owner == verifier) {
            revert VerifierConflict(verifier);
        }

        if (address(verifierStakingLedger) != address(0)) {
            if (!verifierStakingLedger.isStaked(verifier)) {
                revert InsufficientVerifierStake(verifier);
            }
        }

        hasVoted[bundleId][verifier] = true;
        bundle.assignedVerifier = verifier;
        bundleVerifiers[bundleId] = verifier;
        if (approved) {
            _approvers[bundleId].push(verifier);
        }

        if (address(verifierStakingLedger) != address(0)) {
            verifierStakingLedger.updateReputation(verifier, approved);
            verifierStakingLedger.lockStake(verifier);
        }

        emit VerificationRecorded(bundleId, verifier, approved);
    }

    function getApprovers(bytes32 bundleId) external view returns (address[] memory) {
        return _approvers[bundleId];
    }

    // ---------------------------------------------------------------- minting

    function mintCredit(
        bytes32 bundleId,
        uint256 co2Tonnage,
        uint16 vintageYear
    ) external onlyRelayerOrOwner returns (uint256 tokenId) {
        if (address(carbonCreditNFT) == address(0)) {
            revert InvalidNFTContract();
        }

        EvidenceBundle storage bundle = evidenceBundles[bundleId];
        if (!bundle.isCommitted) {
            revert BundleNotCommitted(bundleId);
        }
        if (bundle.isMinted) {
            revert BundleAlreadyMinted(bundleId);
        }
        if (!bundle.riskEvaluated) {
            revert RiskNotEvaluated(bundleId);
        }
        bool quorumApproved = bundle.verifierRequired && bundle.verifierApproved;

        // Cross-source disagreement is a hard stop unless an independent verifier quorum signed off.
        if (!bundle.correlationMet && !quorumApproved) {
            revert CorrelationNotMet(bundleId);
        }

        // Low AI confidence likewise requires verifier approval.
        if (!bundle.confidenceMet && !quorumApproved) {
            revert ConfidenceThresholdNotMet(bundleId);
        }

        Project storage project = projects[bundle.projectId];
        if (!project.exists || project.status != ProjectStatus.ACTIVE) {
            revert ProjectNotActive(bundle.projectId);
        }

        address recipient = project.owner;

        bundle.isMinted = true;
        tokenId = carbonCreditNFT.mint(
            recipient,
            bundle.projectId,
            bundleId,
            bundle.merkleRoot,
            co2Tonnage,
            vintageYear
        );

        bundle.mintedTokenId = tokenId;
        credits[tokenId] = CreditRecord({
            tokenId: tokenId,
            projectId: bundle.projectId,
            bundleId: bundleId,
            status: CreditStatus.ISSUED,
            disputeReason: "",
            disputeInitiator: address(0),
            preDisputeStatus: ICarbonCreditNFT.CreditStatus.ISSUED
        });

        emit CreditIssued(tokenId, bundle.projectId, bundleId, recipient);
        return tokenId;
    }

    // ----------------------------------------------------------------- escrow

    function registerEscrow(uint256 tokenId, bytes32 escrowId) external onlyEscrow {
        tokenToEscrow[tokenId] = escrowId;
        if (credits[tokenId].tokenId == tokenId) credits[tokenId].status = CreditStatus.ESCROWED;
    }

    function clearEscrow(uint256 tokenId) external onlyEscrow {
        delete tokenToEscrow[tokenId];
        if (credits[tokenId].tokenId == tokenId && credits[tokenId].status == CreditStatus.ESCROWED) {
            credits[tokenId].status = CreditStatus.ISSUED;
        }
    }

    // --------------------------------------------------------------- disputes

    function disputeCredit(uint256 tokenId, string calldata reason) external onlyRelayerOrOwner {
        _dispute(tokenId, msg.sender, reason);
    }

    /// @notice Relayer opens a dispute on behalf of an authenticated buyer / regulator.
    function disputeCreditBy(uint256 tokenId, address initiator, string calldata reason) external onlyRelayerOrOwner {
        _dispute(tokenId, initiator, reason);
    }

    function _dispute(uint256 tokenId, address initiator, string calldata reason) internal {
        CreditRecord storage credit = credits[tokenId];
        if (credit.tokenId != tokenId || tokenId == 0) revert CreditNotDisputable(tokenId);

        (, , , , , ICarbonCreditNFT.CreditStatus current) = carbonCreditNFT.getCreditDetails(tokenId);
        if (
            current != ICarbonCreditNFT.CreditStatus.ISSUED &&
            current != ICarbonCreditNFT.CreditStatus.ESCROWED &&
            current != ICarbonCreditNFT.CreditStatus.TRANSFERRED
        ) {
            revert CreditNotDisputable(tokenId);
        }

        credit.preDisputeStatus = current;
        credit.status = CreditStatus.DISPUTED;
        credit.disputeReason = reason;
        credit.disputeInitiator = initiator;
        carbonCreditNFT.setCreditStatus(tokenId, ICarbonCreditNFT.CreditStatus.DISPUTED);

        emit CreditDisputed(tokenId, initiator, reason);
    }

    /**
     * @notice 3-way settlement. If upheld: (1) credit permanently revoked, (2) buyer refunded 100% from escrow,
     *         (3) every verifier that approved the evidence is slashed SLASH_PERCENTAGE% of their stake.
     */
    function resolveDispute(
        uint256 tokenId,
        bool upholdDispute,
        string calldata resolutionDetails
    ) external onlyRelayerOrOwner {
        CreditRecord storage credit = credits[tokenId];
        if (credit.status != CreditStatus.DISPUTED) {
            revert CreditNotInDispute(tokenId);
        }

        if (upholdDispute) {
            uint256 refunded;
            bytes32 escrowId = tokenToEscrow[tokenId];
            if (escrowId != bytes32(0) && address(escrowSettlement) != address(0)) {
                refunded = escrowSettlement.refundEscrow(escrowId);
            }

            carbonCreditNFT.setCreditStatus(tokenId, ICarbonCreditNFT.CreditStatus.REVOKED);
            credit.status = CreditStatus.REVOKED;

            uint256 totalSlashed;
            if (address(verifierStakingLedger) != address(0)) {
                address[] storage approvers = _approvers[credit.bundleId];
                for (uint256 i = 0; i < approvers.length; i++) {
                    try verifierStakingLedger.slashVerifier(approvers[i], SLASH_PERCENTAGE, bytes32(tokenId)) returns (uint256 amt) {
                        totalSlashed += amt;
                    } catch {
                        // verifier has nothing left to slash
                    }
                }
            }

            emit CreditRevoked(tokenId, resolutionDetails);
            emit DisputeResolved(tokenId, true, refunded, totalSlashed, resolutionDetails);
        } else {
            carbonCreditNFT.setCreditStatus(tokenId, credit.preDisputeStatus);
            credit.status = credit.preDisputeStatus == ICarbonCreditNFT.CreditStatus.ESCROWED
                ? CreditStatus.ESCROWED
                : CreditStatus.ISSUED;
            emit DisputeDismissed(tokenId);
            emit DisputeResolved(tokenId, false, 0, 0, resolutionDetails);
        }
    }
}
