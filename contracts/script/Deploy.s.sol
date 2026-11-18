// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Script, console } from "forge-std/Script.sol";
import "../src/CarbonCreditNFT.sol";
import "../src/CarbonRegistry.sol";
import "../src/VerifierStakingLedger.sol";
import "../src/EscrowSettlement.sol";

contract DeployScript is Script {
    function setUp() public {}

    function run() public {
        // Default key is Anvil account #0 (public dev key) - override with PRIVATE_KEY for any real network.
        uint256 deployerPrivateKey = vm.envOr(
            "PRIVATE_KEY",
            uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80)
        );
        address deployer = vm.addr(deployerPrivateKey);
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);
        // Short windows so the escrow-refund and unstake-lock behaviour can be shown live.
        uint256 challengeWindow = vm.envOr("CHALLENGE_WINDOW_SECONDS", uint256(120));
        uint256 stakeLock = vm.envOr("STAKE_LOCK_SECONDS", uint256(300));

        console.log("=== Deploying Carbonyx Protocol ===");
        console.log("Deployer / relayer:", deployer);

        vm.startBroadcast(deployerPrivateKey);

        CarbonCreditNFT nft = new CarbonCreditNFT("Carbonyx Verified Carbon Credit", "CARBX");
        VerifierStakingLedger staking = new VerifierStakingLedger();
        EscrowSettlement escrow = new EscrowSettlement();
        CarbonRegistry registry = new CarbonRegistry();

        registry.setCarbonCreditNFT(address(nft));
        registry.setVerifierStakingLedger(address(staking));
        registry.setEscrowSettlement(address(escrow));
        registry.setTrustedRelayer(deployer, true);

        nft.setRegistry(address(registry));
        nft.setEscrowContract(address(escrow));

        staking.setRegistry(address(registry));
        staking.setTreasury(treasury);
        staking.setLockPeriod(stakeLock);

        escrow.setRegistry(address(registry));
        escrow.setCarbonCreditNFT(address(nft));
        escrow.setChallengeWindow(challengeWindow);

        vm.stopBroadcast();

        console.log("CarbonCreditNFT:", address(nft));
        console.log("VerifierStakingLedger:", address(staking));
        console.log("EscrowSettlement:", address(escrow));
        console.log("CarbonRegistry:", address(registry));
        console.log("Treasury:", treasury);
        console.log("Challenge window (s):", challengeWindow);
        console.log("Stake lock (s):", stakeLock);
    }
}
