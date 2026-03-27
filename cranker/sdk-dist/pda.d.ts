import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
/** Derive the protocol PDA. */
export declare function findProtocolAddress(programId?: PublicKey): [PublicKey, number];
/** Derive a market PDA from its token mint and creator. */
export declare function findMarketAddress(tokenMint: PublicKey, creator: PublicKey, programId?: PublicKey): [PublicKey, number];
/** Derive a user position PDA. */
export declare function findPositionAddress(market: PublicKey, user: PublicKey, programId?: PublicKey): [PublicKey, number];
/** Derive the vault PDA for a market. */
export declare function findVaultAddress(market: PublicKey, programId?: PublicKey): [PublicKey, number];
/** Derive the PerkOracle PDA for a token mint. */
export declare function findPerkOracleAddress(tokenMint: PublicKey, programId?: PublicKey): [PublicKey, number];
/** Derive a trigger order PDA. */
export declare function findTriggerOrderAddress(market: PublicKey, user: PublicKey, orderId: number | BN, programId?: PublicKey): [PublicKey, number];
//# sourceMappingURL=pda.d.ts.map