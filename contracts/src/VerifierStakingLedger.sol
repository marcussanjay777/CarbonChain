// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IVerifierStakingLedger } from "./interfaces/IVerifierStakingLedger.sol";

/**
 * @title VerifierStakingLedger
 * @notice Manages staked collateral, reputation scores, slashing, and verifier pool eligibility.
 * @dev Slashed collateral is forwarded to `treasury`. A verifier who casts an audit vote has their
 *      stake locked for `lockPeriod` so they cannot approve fraud and immediately withdraw.
 */
contract VerifierStakingLedger is Ownable, ReentrancyGuard, IVerifierStakingLedger {
    uint256 public constant MINIMUM_STAKE = 0.1 ether;
    address public registry;
    address public treasury;
    uint256 public lockPeriod = 30 days;

    struct VerifierProfile {
        uint256 stakedAmount;
        uint256 reputationScore;
        uint256 totalVerified;
        uint256 totalSlashed;
        uint256 lockedUntil;
        bool exists;
    }

    mapping(address => VerifierProfile) private _verifiers;

    modifier onlyRegistryOrOwner() {
        require(msg.sender == registry || msg.sender == owner(), "Not registry or owner");
        _;
    }

    constructor() Ownable(msg.sender) {
        treasury = msg.sender;
    }

    function setRegistry(address _registry) external onlyOwner {
        registry = _registry;
    }

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "Zero treasury");
        treasury = _treasury;
    }

    function setLockPeriod(uint256 seconds_) external onlyOwner {
        lockPeriod = seconds_;
    }

    function stake() external payable override {
        require(msg.value > 0, "Stake must be > 0");

        VerifierProfile storage profile = _verifiers[msg.sender];
        if (!profile.exists) {
            profile.exists = true;
            profile.reputationScore = 100;
        }

        profile.stakedAmount += msg.value;
        emit VerifierStaked(msg.sender, msg.value);
    }

    function unstake(uint256 amount) external override nonReentrant {
        VerifierProfile storage profile = _verifiers[msg.sender];
        require(block.timestamp >= profile.lockedUntil, "Stake locked by recent audit");
        require(profile.stakedAmount >= amount, "Insufficient staked balance");
        require(
            profile.stakedAmount - amount >= MINIMUM_STAKE || profile.stakedAmount - amount == 0,
            "Remaining stake must meet minimum or be 0"
        );

        profile.stakedAmount -= amount;
        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        require(sent, "Failed to send ETH");

        emit VerifierUnstaked(msg.sender, amount);
    }

    function slashVerifier(address verifier, uint256 percentage, bytes32 ref)
        external
        override
        onlyRegistryOrOwner
        nonReentrant
        returns (uint256 slashedAmount)
    {
        require(percentage > 0 && percentage <= 100, "Invalid slash percentage");
        VerifierProfile storage profile = _verifiers[verifier];
        require(profile.stakedAmount > 0, "Verifier has no stake to slash");

        slashedAmount = (profile.stakedAmount * percentage) / 100;
        profile.stakedAmount -= slashedAmount;
        profile.totalSlashed += slashedAmount;

        profile.reputationScore = profile.reputationScore >= 30 ? profile.reputationScore - 30 : 0;

        emit VerifierSlashed(verifier, slashedAmount, ref);
        emit ReputationUpdated(verifier, profile.reputationScore);

        (bool sent, ) = payable(treasury).call{value: slashedAmount}("");
        require(sent, "Slash transfer to treasury failed");
        return slashedAmount;
    }

    function updateReputation(address verifier, bool successfulAudit) external override onlyRegistryOrOwner {
        VerifierProfile storage profile = _verifiers[verifier];
        require(profile.exists, "Verifier does not exist");

        profile.totalVerified++;
        if (successfulAudit) {
            if (profile.reputationScore < 100) {
                profile.reputationScore = profile.reputationScore + 1 > 100 ? 100 : profile.reputationScore + 1;
            }
        } else {
            profile.reputationScore = profile.reputationScore > 5 ? profile.reputationScore - 5 : 0;
        }

        emit ReputationUpdated(verifier, profile.reputationScore);
    }

    function lockStake(address verifier) external override onlyRegistryOrOwner {
        VerifierProfile storage profile = _verifiers[verifier];
        profile.lockedUntil = block.timestamp + lockPeriod;
        emit StakeLocked(verifier, profile.lockedUntil);
    }

    function isStaked(address verifier) external view override returns (bool) {
        return _verifiers[verifier].stakedAmount >= MINIMUM_STAKE;
    }

    function lockedUntil(address verifier) external view returns (uint256) {
        return _verifiers[verifier].lockedUntil;
    }

    function getVerifierProfile(address verifier) external view override returns (
        uint256 stakedAmount,
        uint256 reputationScore,
        uint256 totalVerified,
        uint256 totalSlashed
    ) {
        VerifierProfile storage p = _verifiers[verifier];
        return (p.stakedAmount, p.reputationScore, p.totalVerified, p.totalSlashed);
    }
}
