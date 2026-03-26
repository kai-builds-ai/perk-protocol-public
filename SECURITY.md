# Security

## Security Model

Perk Protocol runs as a single on-chain Anchor program on Solana. Security is enforced at multiple layers:

**On-chain program:**
- All arithmetic uses checked math — no silent overflows
- PDA derivation for all program-owned accounts
- Admin operations gated by protocol authority
- Conservation invariants enforced on every state transition

**Oracle system (PerkOracle):**
- Staleness checks reject outdated price data
- Confidence banding rejects unreliable feeds
- Automatic freeze on anomalous price movement
- Rate limiting on update frequency
- Fallback oracle support

**Risk engine:**
- Margin requirements enforced before position changes
- Liquidation triggers based on real-time margin ratio
- Insurance fund epoch payouts for socialized loss

**Verification:**
- 117 Kani formal verification proofs (arithmetic, invariants, safety, liveness)
- 5.9 billion fuzz iterations
- 13 independent audit reports across program, SDK, cranker, oracle, and frontend

## Responsible Disclosure

If you discover a vulnerability, please report it privately:

**Email:** contact@perk.fund

Do not open public issues for security vulnerabilities.

We will acknowledge receipt within 48 hours and provide an initial assessment within 7 days.

## Audit Reports

All final-round audit reports are published in the [`audits/`](audits/) directory.
