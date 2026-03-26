import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  PERK_PROGRAM_ID,
  PROTOCOL_SEED,
  MARKET_SEED,
  POSITION_SEED,
  VAULT_SEED,
  TRIGGER_SEED,
  PERK_ORACLE_SEED,
} from "./constants";

/** Derive the protocol PDA. */
export function findProtocolAddress(
  programId: PublicKey = PERK_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([PROTOCOL_SEED], programId);
}

/** Derive a market PDA from its token mint and creator. */
export function findMarketAddress(
  tokenMint: PublicKey,
  creator: PublicKey,
  programId: PublicKey = PERK_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [MARKET_SEED, tokenMint.toBuffer(), creator.toBuffer()],
    programId
  );
}

/** Derive a user position PDA. */
export function findPositionAddress(
  market: PublicKey,
  user: PublicKey,
  programId: PublicKey = PERK_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POSITION_SEED, market.toBuffer(), user.toBuffer()],
    programId
  );
}

/** Derive the vault PDA for a market. */
export function findVaultAddress(
  market: PublicKey,
  programId: PublicKey = PERK_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, market.toBuffer()],
    programId
  );
}

/** Derive the PerkOracle PDA for a token mint. */
export function findPerkOracleAddress(
  tokenMint: PublicKey,
  programId: PublicKey = PERK_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [PERK_ORACLE_SEED, tokenMint.toBuffer()],
    programId
  );
}

/** Derive a trigger order PDA. */
export function findTriggerOrderAddress(
  market: PublicKey,
  user: PublicKey,
  orderId: number | BN,
  programId: PublicKey = PERK_PROGRAM_ID
): [PublicKey, number] {
  const orderIdBn = BN.isBN(orderId) ? orderId : new BN(orderId);
  return PublicKey.findProgramAddressSync(
    [
      TRIGGER_SEED,
      market.toBuffer(),
      user.toBuffer(),
      orderIdBn.toArrayLike(Buffer, "le", 8),
    ],
    programId
  );
}
