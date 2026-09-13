# Launch flow: parity with 2G8jCXX6…pump (Datadog) and 5LPRbTRq…pump (StonkHouse)

Status: spec for implementation. Every number below was decoded read-only from
mainnet in September 2026, from two real pump.fun launches. No transaction was
simulated and no key was used.

Repo: `/home/adriel/web3-engineer/pumpfun-launchpad` (WSL ext4, canonical).

Purpose: make one launch from this launchpad reproduce, in one slot, the same
transaction pack, the same pool seed and the same pool state as the two
reference coins.

---

## 1. Reference launches (the template)

Two coins, two different creators, two different days, one identical structure.

```
coin            Datadog                      StonkHouse
mint            2G8jCXX6HCTtXmZ8ngS2Z3qs…    5LPRbTRqc37wWt6kGeyLgitn…
slot            446446487                    446110209
created (unix s) 1789221485                   1789114862
creator         2ga4pVmMwe5aUKUtKnomj8mv…    FCca5AAMxcYNxEWYKWycrW36…
```

Four transactions, one slot, this order:

```
tx  role              signers              fee payer   priority   net SOL to curve
A   create + dev buy  creator + mint       creator     20 000     0.98907164
B   fill (2 buys)     wallet2 + wallet3    wallet2     17 500     39.506172836
C   fill (2 buys)     wallet4 + wallet5    wallet4     17 500     44.511531901
D   MigrateV2         creator              creator     25 000     (moves the fill)
                                                               sum 85.006776377
```

StonkHouse, same shape, different amounts:

```
A   create + dev buy  creator + mint       creator     20 000     0.051149622
B   fill (2 buys)     wallet2 + wallet3    wallet3     17 500     29.629629626
C   fill (2 buys)     wallet4 + wallet5    wallet4     17 500     55.326346716
                                                               sum 85.007125964
```

Per-transaction fee arithmetic (verified against `meta.fee`):

```
A : 2 signatures => base 10 000 + priority 20 000 = 30 000 lamports
B,C: 2 signatures => base 10 000 + priority 17 500 = 27 500 lamports
D : 1 signature   => base  5 000 + priority 25 000 = 30 000 lamports
```

Instruction shape:

```
A : ComputeBudget(setComputeUnitLimit), ComputeBudget(setComputeUnitPrice),
    create_v2 (pump 6EF8rrecth…), ExtendAccount, ATA createIdempotent, Buy
B,C: ComputeBudget x2, ATA createIdempotent x2, Buy x2   (one buy per wallet, each into that wallet's own ATA)
D : ComputeBudget x2, MigrateV2 (pump), which CPIs:
      PumpSwap CreatePool  -> creates the canonical pool + LP mint
      MintTo               -> mints the LP supply
      init_boost           -> AMM boost leg (see section 5)
```

Fixed protocol amounts, identical in both launches:

```
fill (net SOL the curve must receive)      85.005359057 SOL
fill gross at the 125 bps input fee        86.081376261 SOL
pool base vault seed                       206 900 000 000 000 raw  (206.9M tokens)
pool real quote vault (measured)           67.407342208 / 67.407709337 SOL
boost vault at migration                   17.585993728 / 17.586360857 SOL
boost split of the fill                    79.31 % pool / 20.69 % boost
pool.virtualQuoteReserves                  17 584 505 288 lamports   (both coins, identical)
pool.lpSupply                              4 193 388 282 604         (both coins, identical)
pool.coinCreator                           == the curve creator
pool.isMayhemMode / isCashbackCoin         false / false
pool index / quote mint                    0 / So11111111111111111111111111111111111111112
```

Surplus above the fill that stays in the curve account (harmless, untracked):

```
Datadog     0.001417320 SOL   (curve account still holds exactly this)
StonkHouse  0.001766907 SOL   (curve account still holds exactly this)
```

The two launches differ in only three ways: the dev-buy size (0.98907164 vs
0.051149622 SOL), the split point of the fill between tx B and tx C
(46.47/52.36 vs 34.86/65.09 percent), and the resulting dust deltas. There is
no second template.

Evidence method, per coin: `getSignaturesForAddress` on the bonding curve,
`getBlock(slot, transactionDetails="signatures")` for the exact execution
order, `getTransaction` for `meta.fee`, the signer list, SOL deltas, token
deltas and `meta.innerInstructions`, then `PUMP_AMM_SDK.decodePool` for the
pool fields.

---

## 2. Change list

### C1. Fill-sized chunk buys instead of MAX spends

Current behavior: the launch quotes each dev wallet at its MAX spendable
budget. A wallet bigger than the curve's remaining real tokens over-quotes and
reverts `NotEnoughTokensToBuy` (documented in `docs/DEVNET_MIGRATION_C.md`).

Target behavior: the launch plans the FILL. The selected wallets receive
explicit net deposits whose sum reaches 85.005359057 SOL, and the last buy
requests the remaining real tokens so the curve completes.

Targets:

```
lib/pump.ts:643-669        quotePumpFill — exists, fills with tokensOut = curve.realTokenReserves.
                           Add a sibling that takes an explicit tokensOut:
                           quotePumpChunk(curve, tokensOut, slippageBps) -> { tokensOut, costLamports, maxSolCost }
                           using the same integer ceiling math (lib/pump.ts:520 ceilDiv).
lib/bundle/launch.ts:239-259 quoteLaunchBuys — chain chunk quotes against the curve
                           state, not MAX-budget quotes: after each chunk update
                           vSol += net, vTok -= tokensOut, rTok -= tokensOut.
lib/bundle/launch.ts:119-139 BuyAllocation — carry the planned net deposit per wallet.
components/launch-panel.tsx:421  the panel must submit the planned amounts, not MAX.
lib/batch-trade.ts:136-205 buyOne (MAX) — leave for manual trading; never use it in a launch.
```

Done when: for the planned wallet set, `sum(net_i) >= 85.005359057 SOL` and the
final buy has `tokensOut == rTok` at its quoted state.

### C2. Two buyers per transaction, and the buyers are the fee payers

Current behavior: the creator is the fee payer of every transaction
(`lib/bundle/launch.ts:164-166`, `:291-316`).

Target behavior: the reference fill transactions are signed by exactly the two
buying wallets, with one of them as fee payer, and the creator is not on them.
`packBuyTxs` already packs two wallets per buy tx
(`lib/bundle/launch.ts:318-338`, measured "2 wallets = 1060 bytes"); keep the
pairing, change the payer.

Targets:

```
lib/bundle/launch.ts:291-316  materializeBuyTx — feePayer = the pair's first wallet;
                              sign only the pair.
lib/bundle/launch.ts:140-160  LaunchSequence.signersByTx — one entry per tx:
                              [creator, mintKeypair], [w2, w3], [w4, w5], [creator].
lib/bundle/launch.ts:162-196  BuildLaunchOptions — the creator no longer pays the
                              fill txs; fund the wallets in a separate, earlier tx
                              (the reference launches had no fund tx in the launch slot).
```

Done when: a built launch sequence shows 4 txs with signer counts 2, 2, 2, 1 and
the creator absent from tx B and tx C.

### C3. Same-slot pack, with an explicit MigrateV2 as the last transaction

Current behavior: the sequence ends at the buy txs
(`lib/bundle/launch.ts:140-160`, `:438 buildLaunchSequence`), and the migration
is expected to happen inside the graduating buy
(`docs/DEVNET_MIGRATION_C.md` lines 55-63).

Reference reality: the pool creation is inside a SEPARATE `MigrateV2`
transaction, sent by the creator in the same slot, after the fill buys. Neither
reference fill transaction contains `CreatePool`.

Targets:

```
lib/bundle/launch.ts:438      buildLaunchSequence — add migrateTx (+ its signers)
                              after the buy txs.
lib/migrate.ts:146-148        PUMP_MIGRATE_DISCRIMINATOR (v1) — exists, keep exported.
lib/migrate.ts:177            buildPumpMigrateIx({ baseMint, user }) (v1) — exists, keep exported.
lib/migrate.ts (add)          PUMP_MIGRATE_V2_DISCRIMINATOR = [187, 203, 18, 31, 206, 237, 254, 41]
                              from the official IDL; equals sha256("global:migrate_v2")[0:8].
lib/migrate.ts (add)          buildPumpMigrateV2Ix({ baseMint, user, quoteMint? }) — the 27 IDL
                              accounts in exact order plus the 2 boost remaining accounts (C3a).
                              This is the instruction the launch must send.
lib/bundle/launch.ts:626      buildLaunchSequence must call the v2 builder, not the v1 one.
scripts/devnet-migration-c.mjs  the manual migrate step swaps to the v2 builder too.
lib/migrate.ts:153-155        PUMP_DEVNET_WITHDRAW_AUTHORITY — keep as the devnet value.
lib/migrate.ts (add)          PUMP_MAINNET_WITHDRAW_AUTHORITY = 39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg
                              plus a PURE resolver `withdrawAuthorityFor(network: SolanaNetwork):
                              PublicKey` (devnet -> 5PXxuZkvftsg5CAGjv5LL5tEtvBRskdx1AAjxw8hK2Qx,
                              mainnet -> 39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg), so the
                              branch is testable offline.
lib/migrate.ts:234            the withdraw_authority account (index 1) must take the value from
                              the resolver. It must never use the devnet constant on mainnet.
scripts/devnet-migration-c.mjs:493, :746   the working manual migrate call to lift into the sequence.
```

Requirements:

1. All four transactions must land in ONE slot, in the order A, B, C, D. Use
   the existing bundle/protected send path (`lib/bundle/protected-send.ts`,
   `sendSequentially` at `lib/bundle/launch.ts:837`, `jito-js-rpc` in
   `package.json`). The reference launches carried no tip inside the four
   transactions and only 17 500-25 000 lamports of priority, so the order came
   from a bundle or private relay, not from a priority-fee race.
2. Make the migrate idempotent: a revert with `Custom: 6040` means the coin is
   already migrated. Treat it as success. (Seen on chain: a competitor sent
   `MigrateV2 + BuyExactQuoteIn` after the winning migrate and reverted 6040.)
3. Do not skip the explicit migrate. One open question remains: whether the
   mainnet graduating buy also migrates by itself (the devnet observation in
   the docs says it does; both reference coins show it does not). An explicit,
   idempotent MigrateV2 is correct in either case, so this question stops
   blocking the launch.

Done when: one launch produces 4 confirmed transactions in one slot,
`curve.complete == 1` with the canonical pool present, and
`buildPumpMigrateIx` passes the cluster-correct withdraw authority at account
index 1, asserted offline for BOTH clusters by the new resolver test.

#### C3a. The migrate instruction (IDL-verified and chain-verified)

The launch must send pump's `migrate_v2`. The official IDL
(`https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json`,
read 2026-09-13) declares it, and both reference migrations on chain match it
account for account.

```
instruction      migrate_v2, no args, 8 data bytes
discriminator    [187, 203, 18, 31, 206, 237, 254, 41] = bbcb121fceedfe29
                 = sha256("global:migrate_v2")[0:8], confirmed on chain
program log      "Program log: Instruction: MigrateV2"
sent accounts    27 (the IDL list below) + 2 boost remaining accounts = 29 total

IDL order, authoritative                          S/W    derivation
 0 global                                         --     4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf
 1 withdraw_authority                             -W     withdrawAuthorityFor(cluster), see C3
 2 base_mint                                      --     the coin mint
 3 quote_mint                                     --     So11111111111111111111111111111111111111112
 4 bonding_curve                                  -W     PDA(["bonding-curve", base_mint], pump)
 5 associated_base_bonding_curve                  -W     ATA(base_mint, bonding_curve, Token-2022)
 6 associated_quote_bonding_curve                 -W     ATA(quote_mint, bonding_curve, Tokenkeg)
                                                         a native-SOL curve has no such ATA, so the
                                                         reference passes a 0-lamport slot here
 7 user                                           SW     the creator, the only signer
 8 system_program                                 --     11111111111111111111111111111111
 9 pump_amm                                       --     pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
10 pool                                           -W     canonical pool PDA
11 pool_authority                                 -W     PDA(["pool-authority", base_mint], pump)
12 pool_authority_mint_account                    -W     ATA(base_mint, pool_authority, Token-2022)
13 pool_authority_quote_account                   -W     ATA(quote_mint, pool_authority, Tokenkeg)
14 amm_global_config                              --     ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw
15 lp_mint                                        -W     PDA(["pool_lp_mint", pool], pump_amm)
16 user_pool_token_account                        -W     ATA(lp_mint, pool_authority, Token-2022)
17 pool_base_token_account                        -W     ATA(base_mint, pool, Token-2022)
18 pool_quote_token_account                       -W     ATA(quote_mint, pool, Tokenkeg)
19 base_token_program                             --     TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
20 quote_token_program                            --     TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
21 token_2022_program                              --     TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
22 associated_token_program                       --     ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
23 pump_amm_event_authority                        --     GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR
24 rent                                           --     SysvarRent111111111111111111111111111111111
25 event_authority                                --     PDA(["__event_authority"], pump)
                                                         = Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1
26 program                                        --     6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
--- remaining accounts appended after the 27 ---
27 boost_vault_authority                          --     PDA(["boost_vault", pool], pump_amm)
28 boost_vault_ata                                -W     ATA(quote_mint, boost_vault_authority, Tokenkeg)

provenance, both successful, both pay the withdraw authority, all 29 positions matched
Datadog    3LwyDmXnaCoFUK7t1XpxFY4EQpMDKRbi1Kgk7QWjSCcfvDFE24D7d9okiY5DXVRu2wLDsx6jkBeE1azQGL39ARKs
StonkHouse XkK4vCcoQzP2fWyBceDto4q38Ekpe3oYgXAxZxbcbXmgH7hcRAXfyWoL93gri514Lvw6vmJ9gcwyKP7Fui9NMu7
```

Captured Datadog row, raw addresses, for offline tests (all 29 positions as sent
by the successful migration):

```
[ 0] 4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf
[ 1] 39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg
[ 2] 2G8jCXX6HCTtXmZ8ngS2Z3qs6z2BJzLhdJt7YNsgpump
[ 3] So11111111111111111111111111111111111111112
[ 4] 2NBq1kemNNnKNgi5FgTs8yHNkdRUMMcH1w64PW7uwKzY
[ 5] CQ3dU94HDykjtCEGhcqnyPDrTu3YRPT5fmSVdVUq5rxw
[ 6] 7pWduEEMGPipy1mqKM4jqXN9wHXSJC1acpXofBp8f586
[ 7] 2ga4pVmMwe5aUKUtKnomj8mvG9rj7DivF8Q3MKWEMLyw
[ 8] 11111111111111111111111111111111
[ 9] pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
[10] 3WkN2cs4rCQthRxnrgqmKgYT28SQJWoqSYzp8eRmPR1D
[11] DxDMoct8QJtwHNprFSsd84wRKizxE3JnYn2ADn81UT2r
[12] 7tdSkm2ACkjJ2KWmi2TbcrjKtTTwNY7bsCJvCkvDXmEb
[13] 3MdRuksXE1n8A5bxhwVLzCuadCWpjnrkmr5hMgbNsux2
[14] ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw
[15] BcjG8ZPqqik1LX1gvFKnVH3bTtV2DCq8NF1H9Lt6ojCF
[16] AqrTtJ1EscF6MMTVogR3wnrLY3CLZ6k4YK9CgriW4kiT
[17] Dn6VJUM3ebTy25z1JW1iMLLo9JvVLQ9dZ7fJP3i4mrQF
[18] 6v9Ed4TKEm6Kh2D5MKHYp2e9pBtaRFSamkZBg7CyC9YZ
[19] TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
[20] TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
[21] TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
[22] ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
[23] GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR
[24] SysvarRent111111111111111111111111111111111
[25] Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1
[26] 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
[27] C2gXtzdP4c9FfKBHubunoARnP2rzPdda7p4jUKpcEpQ6
[28] 5e2HDNNWsDtB8ziYUsSY5nrRtVsrU2dtkVum7mwb39Xn
```

Index 1 carries the measured mainnet withdraw authority and receives the curve's
leftover SOL (+0.008909081 SOL on Datadog, +0.007406734 SOL on StonkHouse).
Index 6 sits at 0 lamports before and after on both: a native-SOL curve has no
WSOL ATA, and the launcher still passes the derived address.

The v1 `migrate` (discriminator 9beae792ec9ea21e, 25 accounts) is still in the
current IDL and stays exported. Historical mainnet v1 transactions used a
24-account layout from an older program build, so v1 and v2 accounts must never
be mixed.

### C4. Boost-aware pricing

Every reference pool carries a virtual quote reserve on top of the real vault:
17 584 505 288 lamports for both coins (20.7 percent of the opening price
basis). Any price or market cap computed from the pool quote vault alone is
about 20.7 percent too low.

Targets:

```
components/roster.tsx:166-199   the graduated-holder price helper divides the pool
                                quote ATA balance by the base reserve; add
                                pool.virtualQuoteReserves to the numerator.
lib/swap.ts:62-161              already correct: the SDK adds virtualQuoteReserves
                                internally (verified in @pump-fun/pump-swap-sdk
                                buyBaseInput / buyQuoteInput / sellBaseInput /
                                sellQuoteInput, each of which computes
                                effectiveQuoteReserve = quoteReserve + virtualQuoteReserves).
                                Keep using swapSolanaState; do not hand-roll reserves.
scripts/devnet-migration-c.mjs:389,406,772  decode the pool with
                                PUMP_AMM_SDK.decodePool (already used) and print the
                                boost fields in the report.
```

Done when: no code path computes a pool price from `poolQuoteTokenAccount`
alone, and the report prints `virtualQuoteReserves`.

---

## 3. Exact fill math

On-chain semantics of pump's `buy` (program `6EF8rrecth…`):

```
instruction args:  amount = tokens_out (raw),  max_sol_cost (lamports)
program computes:  cost  = ceil(tokens_out * virtual_sol / (virtual_tokens - tokens_out))   [SOL added to the curve, net of fee]
program floors:    net   = floor(sol_in * 9875 / 10000)          <- 125 bps input fee, floored PER BUY
program requires:  sol_in = ceil(cost * 10000 / 9875) <= max_sol_cost
state after:       virtual_sol += net;  virtual_token -= tokens_out;  real_token -= tokens_out
```

The curve is a HARD CAP: an oversized `tokens_out` reverts
`NotEnoughTokensToBuy`; the program does not clamp.

Chunk plan for a launch of n buys:

```
for i < n:   tokens_out_i = the share of the remaining real tokens for this wallet
             cost_i  = ceil(tokens_out_i * vSol / (vTok - tokens_out_i))
             maxSolCost_i = ceil(cost_i * 10000 / 9875)     (+ optional slippage headroom)
             then chain: vSol += floor(maxSolCost_i... net); vTok -= tokens_out_i
for i = n:   tokens_out_n = rTok   (all remaining real tokens)  <- this buy graduates the curve
```

Rules that the reference launches obey and this launch must obey:

1. The sum of the per-buy net deposits must be >= the fill: 85.005359057 SOL on
   mainnet, 2.833511969 SOL on devnet (the virtual SOL seed is 1 SOL there, not
   30 SOL). Read the seed live (`lib/bundle/launch.ts:214 resolveLaunchCurveSeed`,
   `lib/pump.ts:150 readPumpGlobalParams`) and never use a hardcoded 30 SOL on devnet.
2. The final buy must request the remaining real tokens (0 left after it), so
   the curve completes no matter how the earlier floors rounded.
3. Give the earlier chunks a small headroom (100-300 bps is enough). The
   reference launches over-deposited 0.0014-0.0018 SOL in total; the program
   charges its own computed cost, so the excess is stranded in the curve
   account and costs nothing.
4. The fee is floored per buy, so an exact-fit plan can land a few lamports
   short (the docs record a 4-lamport shortfall for a 5-wallet devnet fill).
   The graduating final buy removes this trap.
5. Fee constant: use 125 bps (`PUMP_FEE_BPS`, `lib/pump.ts:249`). Do NOT use
   `FEE_BPS = 100` (`lib/params.ts:60`); it is unreferenced and 0.25 percent short.

Reference splits to copy:

```
Datadog     dev buy 0.98907164   | fill B 39.506172836 (46.47 %) | fill C 44.511531901 (52.36 %)
StonkHouse  dev buy 0.051149622  | fill B 29.629629626 (34.86 %) | fill C 55.326346716 (65.09 %)
```

---

## 4. Assertion list (cluster aware)

Measured reference table. The devnet column was measured on 2026-09-13 from the
rehearsal migration (mint 7d2zZF2gXJUe8HkdS4hAGFCr633kKozMksZ62udgoCEP, pool
6TLFXvnypA7RFmdSH2k4M3GaeBBBerG2CvgYARAQwaxU). The mainnet column comes from
the two reference migrations.

```
                                     mainnet (reference)        devnet (rehearsal)
CLUSTER-INVARIANT
  poolBaseTokenAccount amount        206 900 000 000 000 raw    206 900 000 000 000 raw
  curve.complete                     true                      true
  curve realTokenReserves after      0                         0
  isMayhemMode / isCashbackCoin      false / false             false / false
CLUSTER-DEPENDENT
  fill net (lamports)                85 005 359 057            2 833 511 969
  pool quote vault at migration      67 407 342 208            2 235 361 842
  boost vault at migration           17 585 993 728            583 150 126
  pool.virtualQuoteReserves          17 584 505 288            583 150 126
  pool.lpSupply                      4 193 388 282 604         763 642 669 171
  protocol take (fill - vault - boost) 12 023 121              15 000 001
```

Implement it once and call it from three places:

```
lib/pool-assertions.ts (new, pure, no RPC)
  export const CLUSTER_EXPECTED: the table above, keyed by "mainnet" | "devnet"
  export interface MigratedPoolFacts { cluster, mint, curveCreator, curveComplete,
    pool { poolAuthority, baseMint, quoteMint, coinCreator, poolBaseTokenAccount,
           poolQuoteTokenAccount, virtualQuoteReserves, lpSupply, isMayhemMode, isCashbackCoin },
    vaultBaseRaw, vaultQuoteLamports, boostVaultAuthority, boostAtaLamports }
  export function assertMigratedPool(facts, opts?: { slots?: (number | null)[]; atMigration?: boolean }): { name, expected, actual, ok }[]
                                 check 3 needs the four launch slots; without them it must
                                 report "not exercised (sequential sender)", never a pass.
                                 checks 7 (pool base vault), 8 (quote vault) and the balance
                                 half of 12 are MIGRATION-TIME facts: later trades move both
                                 vaults and the boost ATA is spent and drained afterwards.
                                 With atMigration false they must report
                                 "not applicable (late read)", never a pass and never a
                                 failure. Checks 9 and 10 read pool fields that stay static,
                                 so they stay valid at any time.
scripts/devnet-migration-c.mjs   call it after T1 with atMigration true and on the --mint
                                 resume path with atMigration false; print the table, write it
                                 into docs/DEVNET_MIGRATION_PROOF.md, and exit non-zero if any
                                 check fails, EXCEPT the "not exercised (sequential sender)" and
                                 "not applicable (late read)" entries, which are expected there.
                                 On a resume the T2 sell step must SKIP a wallet that holds no
                                 base tokens and log the skip, instead of asserting.
components/launch-panel.tsx      the post-launch verification report prints the same table
tests/launch-fill-plan.ts        feed the Datadog row (C3a) and the devnet rehearsal row
                                 through assertMigratedPool and require every check ok
```

The 13 checks:

```
1  curve.complete == 1
2  pool exists at canonicalMigratedPoolPda(mint)
3  all four launch txs share one slot            MAINNET only. The devnet runner sends
                                                 sequentially, so it must report this check as
                                                 "not exercised", never as a pass.
4  pool.baseMint == mint, pool.quoteMint == WSOL
5  pool.coinCreator == curve.creator
6  pool.poolAuthority == pumpPoolAuthorityPda(mint)
7  vaultBaseRaw == 206 900 000 000 000
8  vaultQuoteLamports == CLUSTER_EXPECTED[cluster].quoteVault      (tolerance 2 000 000)
9  pool.virtualQuoteReserves == CLUSTER_EXPECTED[cluster].virtualQuoteReserves
   NOTE the boost vault balance and the recorded virtual reserve are DIFFERENT on
   mainnet (17 585 993 728 against 17 584 505 288). Check 12 uses the former,
   check 9 the latter. Never compare check 9 to the boost figure.
10 pool.lpSupply == CLUSTER_EXPECTED[cluster].lpSupply
11 pool.isMayhemMode == false and pool.isCashbackCoin == false
12 boostVaultAuthority == PDA(["boost_vault", pool], pAMMBay6) and
   boostAtaLamports == CLUSTER_EXPECTED[cluster].boost (read at migration; the ATA is
   spent and drained afterwards, so a later read is expected to be lower)
13 pool.coinCreator == the wallet that claims creator fees
```

Offline unit tests (extend the existing suite, keep a-d passing):

```
a  chunk quoting is monotonic and the final buy takes rTok exactly
b  sum(net_i) >= 85 005 359 057 lamports for the planned mainnet plan
c  the per-buy floor case: 5 equal deposits that land short must still graduate
   because the last buy requests the remainder
d  a chunk with tokens_out == rTok + 1 throws (hard cap, no clamping)
e  assertMigratedPool returns ok for the mainnet reference row and for the devnet
   rehearsal row, and returns not-ok when exactly one value is perturbed
```

---

## 5. Boost: no client work, but assert it

The boost is an AMM instruction, invoked internally by pump's `MigrateV2`. It is
not sent by the client and must not be hand-built.

```
program     pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA   (PumpSwap AMM)
instruction init_boost
discriminator 8ce9215e845ac28f  = sha256("global:init_boost")[0:8]
accounts (14) pool, global_config, pool_authority, base_mint, quote_mint,
              pool_base_token_account, pool_quote_token_account,
              boost_vault_authority, boost_vault_ata,
              token_program, system_program, associated_token_program,
              event_authority, amm_program
computed      global_config    = PDA(["global_config"], pAMMBay6)
              pool_authority   = PDA(["pool-authority", mint], 6EF8rrecth…)
              event_authority  = PDA(["__event_authority"], pAMMBay6)
              boost_vault_authority = PDA(["boost_vault", pool], pAMMBay6)
              boost_vault_ata       = ATA(WSOL, boost_vault_authority, Tokenkeg)
effect        moves 20.69 % of the migration SOL into the boost vault ATA and
              records pool.virtualQuoteReserves = 17 584 505 288 lamports
live config   global_config.boostEnabled = true
              global_config.boostAuthority = HTVZVEQMBsNanubDPTs3CxDAEGNFQHJY8c1441iy2S5r
SDK helpers   boostVaultAuthorityPda(pool), boostVaultAta(auth, WSOL, Tokenkeg)
later spend   AMM instruction boost_buy_and_burn, discriminator [105,68,6,175,0,7,35,162],
              buys base tokens with the boost quote and burns them
```

Because `boostEnabled` is true, a migration sent today gets the boost
automatically. The only client duty is assertion 9 above and the pricing change
in C4.

---

## 6. Out of scope, do not change

1. Fee rates and tier selection: pump.fun's fee program decides them. Do not
   hardcode 100, 125 or 95 bps into any price.
2. Creator fee claim: `lib/claim-creator-fee.ts` is already correct.
3. The migrated-venue swap path: `lib/swap.ts` already handles
   `virtualQuoteReserves` through the SDK.
4. `programs/pumpfun` (the local harness program) and its `FEE_BPS: u64 = 100`
   constant: local rehearsal only, never deployed.

---

## 7. Verification order

```
1  offline: unit tests a-e (section 4). Zero cost, catches the floor trap.
2  devnet: DONE 2026-09-13. Rehearsal migration mint 7d2zZF2gXJUe8HkdS4hAGFCr633kKozMksZ62udgoCEP,
   pool 6TLFXvnypA7RFmdSH2k4M3GaeBBBerG2CvgYARAQwaxU; fill 2.833511969 SOL net; assertion
   values for this cluster are in section 4. Re-run free at any time with the runner's
   --mint resume path.
3  mainnet pilot: one launch, real 85.005359057 SOL fill, 5 funded wallets. UNBLOCKED ONLY
   BY FUNDING (86 to 88 SOL). Assert all 13 values from section 4, including the one-slot
   check, then run one buy and one sell on the migrated pool to confirm the boost-aware
   pricing (C4).
```

---

## 8. Open items (NOT part of an implementation run)

1. RESOLVED 2026-09-13, no longer open. The mainnet instruction is `migrate_v2`,
   discriminator bbcb121fceedfe29 = sha256("global:migrate_v2")[0:8], 27 IDL
   accounts plus the 2 boost remaining accounts, captured in C3a and matched
   position by position against both reference transactions. A census of 29
   recent mainnet graduations found 27 sending migrate_v2 with 29 accounts, and 2
   older coins sending the v1 `migrate` with a 24-account layout from an older
   program build. The v1 builder is therefore NOT the instruction the launch must
   send; the work item is C3's v2 builder. Settled from the official IDL plus the
   two reference transactions, with no chain action.
2. The assertion block is THIS pass's work item: section 4 now carries the cluster-aware
   table and the `lib/pool-assertions.ts` design. Assertions 9, 11 and 12 already have
   boost reporting in the UI and the devnet script; the remaining checks move into the
   new module.
3. Chain proof status after the 2026-09-13 devnet rehearsal: PROVEN on devnet are the
   fill chaining, `curve.complete`, the migrate_v2 instruction (29 accounts, disc
   bbcb121fceedfe29), the `InitBoost` leg, the pool state, and the boost-aware migrated
   buy and sell. STILL UNEXERCISED: the one-slot pack, which needs a bundle relay and
   every relay in this repo is mainnet only, and the mainnet fee tiers.
4. Tier 2 idempotency, this pass's work item: before submitting a bundle, read the curve
   and the canonical pool. When the pool already exists, drop the migrate transaction
   from the bundle instead of sending it (a bundle cannot swallow a single transaction's
   `Custom: 6040` revert the way the sequential path does).
5. This pass's work item: add to package.json
   `"test": "ts-mocha -p ./tsconfig.test.json tests/launch-fill-plan.ts"` so the offline
   suite runs without the test file's own ts-node registration. Keep the other test files
   out of the script; they are not all offline.
