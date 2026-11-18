// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IVerifierStakingLedger {
    event VerifierStaked(address indexed verifier, uint256 amount);
    event VerifierUnstaked(address indexed verifier, uint256 amount);
    /// @param ref Identifier of what caused the slash (e.g. the disputed tokenId as bytes32)
    event VerifierSlashed(address indexed verifier, uint256 amount, bytes32 indexed ref);
    event ReputationUpdated(address indexed verifier, uint256 newScore);
    event StakeLocked(address indexed verifier, uint256 lockedUntil);

    function stake() external payable;
    function unstake(uint256 amount) external;
    function slashVerifier(address verifier, uint256 percentage, bytes32 ref) external returns (uint256 slashedAmount);
    function updateReputation(address verifier, bool successfulAudit) external;
    function lockStake(address verifier) external;
    function isStaked(address verifier) external view returns (bool);
    function getVerifierProfile(address verifier) external view returns (uint256 stakedAmount, uint256 reputationScore, uint256 totalVerified, uint256 totalSlashed);
}
