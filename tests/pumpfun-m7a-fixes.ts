// Milestone M7a FIX regression tests (F1 graduation payout + F2 ATA grief).
//
// These encode the CORRECTED economics, not the audited bug:
//
//   F1: graduate_impl must release EVERY real lamport the vault holds above
//       its rent-exempt floor. The 30 SOL virtual reserve is synthetic state
//       (create() writes sol_reserve = 30e9; buy() only ever transfers the
//       real sol_in), so the vault holds ~55.56 SOL at the 85-SOL threshold,
//       never 85 SOL. The creator must receive vault_before - rent_min and
//       the vault must be left at exactly rent_min, NOT at 30 SOL.
//
//   F2: an attacker can pre-fund a victim's derived ATA address with a
//       data-less system account (rent-exempt transfer). The on-demand ATA
//       create must recover that account (idempotent create), so the victim's
//       first buy still succeeds.
//
// Runs ONLY on the local validator (the fill needs a free ~60 SOL airdrop;
// devnet's faucet caps at ~2.5 SOL/day). This file is expected to FAIL
// against the pre-fix .so and PASS against the fixed one.

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pumpfun } from "../target/types/pumpfun";
import {
  VIRTUAL_SOL_RESERVE,
  GRADUATION_THRESHOLD_SOL,
} from "../lib/params";

describe("pumpfun (M7a fixes: F1 graduation payout + F2 ATA grief recovery)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Pumpfun as Program<Pumpfun>;
  const connection = provider.connection;

  const METAPLEX_PROGRAM_ID = new PublicKey(
    "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
  );
  const MINT_SEED = Buffer.from("mint");
  const CURVE_SEED = Buffer.from("curve");
  const MINT_AUTHORITY_SEED = Buffer.from("mint_authority");
  const SOL = new BN(LAMPORTS_PER_SOL);

  const mintPda = (creator: PublicKey, nonce: BN): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [MINT_SEED, creator.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
  const curvePda = (mint: PublicKey): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [CURVE_SEED, mint.toBuffer()],
      program.programId
    );
  const mintAuthorityPda = (mint: PublicKey): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [MINT_AUTHORITY_SEED, mint.toBuffer()],
      program.programId
    );

  // buy input for a target *effective* amount (effective = in * 9900 / 10000).
  const solInForEffective = (effectiveLamports: bigint): BN => {
    const num = effectiveLamports * 10000n;
    const den = 9900n;
    return new BN(((num + den - 1n) / den).toString());
  };
  // 55 SOL effective fills the curve exactly (30 virtual + 55 = 85 >= threshold).
  const FILL_EFFECTIVE = GRADUATION_THRESHOLD_SOL - VIRTUAL_SOL_RESERVE;

  const creatorKeypair = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          path.join(os.homedir(), ".config", "solana", "devnet.json"),
          "utf8"
        )
      )
    )
  );
  const creator = provider.wallet.publicKey;

  // The curve account's own rent-exempt floor (the amount F1 leaves behind).
  async function curveRentMin(curveState: PublicKey): Promise<bigint> {
    const info = (await connection.getAccountInfo(curveState, "confirmed"))!;
    return BigInt(
      await connection.getMinimumBalanceForRentExemption(info.data.length)
    );
  }

  async function airdrop(to: PublicKey, sol: number) {
    const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }

  async function createToken(
    nonce: BN,
    name: string,
    symbol: string,
    uri: string,
    opts?: { autoMigrate?: boolean; lockLp?: boolean }
  ) {
    const [mint] = mintPda(creator, nonce);
    const [curveState] = curvePda(mint);
    const [mintAuthority] = mintAuthorityPda(mint);
    const metadata = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), METAPLEX_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      METAPLEX_PROGRAM_ID
    )[0];
    const sig = await program.methods
      .create(
        nonce,
        name,
        symbol,
        uri,
        opts?.autoMigrate ?? false,
        opts?.lockLp ?? true
      )
      .accounts({
        creator,
        mint,
        curveState,
        mintAuthority,
        metadata,
        systemProgram: SystemProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        mplTokenMetadataProgram: METAPLEX_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .rpc();
    await connection.confirmTransaction(sig, "confirmed");
    return { creator, mint, curveState, mintAuthority };
  }

  async function buy(
    buyer: Keypair,
    mint: PublicKey,
    curveState: PublicKey,
    solIn: BN
  ) {
    const buyerAta = await getAssociatedTokenAddress(
      mint,
      buyer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const sig = await program.methods
      .buy(solIn)
      .accounts({
        buyer: buyer.publicKey,
        mint,
        curveState,
        buyerAta,
        creatorAccount: creator,
        creatorAta: getAssociatedTokenAddressSync(
          mint,
          creator,
          false,
          TOKEN_2022_PROGRAM_ID
        ),
        mintAuthority: mintAuthorityPda(mint)[0],
        systemProgram: SystemProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();
    await connection.confirmTransaction(sig, "confirmed");
  }

  async function graduate(mint: PublicKey, curveState: PublicKey) {
    const creatorAta = getAssociatedTokenAddressSync(
      mint,
      creator,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const sig = await program.methods
      .graduate()
      .accounts({
        creator,
        mint,
        curveState,
        creatorAta,
        mintAuthority: mintAuthorityPda(mint)[0],
        systemProgram: SystemProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();
    await connection.confirmTransaction(sig, "confirmed");
  }

  let nonceCounter = 0;
  const NONCE = () => new BN(Date.now() + 300_000 + nonceCounter++);

  before(async () => {
    const bal = await connection.getBalance(creator, "confirmed");
    if (bal < 30 * LAMPORTS_PER_SOL) {
      await airdrop(creator, 60);
    }
  });

  it("F1: graduate releases the FULL real deposits (vault minus rent floor, ~55.56 SOL), stranding nothing", async () => {
    const { mint, curveState } = await createToken(
      NONCE(),
      "F1 Real Fill",
      "F1F",
      "https://example.com/f1.json",
      { autoMigrate: false, lockLp: true }
    );

    // The vault starts at its rent-exempt floor only. No one ever deposits
    // the 30 SOL virtual reserve: it exists purely as curve_state state.
    const rentMinAtCreate = await curveRentMin(curveState);
    const vaultAtCreate = (await connection.getAccountInfo(curveState, "confirmed"))!.lamports;
    expect(vaultAtCreate - Number(rentMinAtCreate)).to.be.lessThan(1 * LAMPORTS_PER_SOL);

    // Fill the curve with REAL lamports via buy() only (55 SOL effective on
    // the ledger crosses the 85-SOL threshold). The vault physically holds
    // only the real sol_in deposits (~55.56 SOL), never 85 SOL.
    const trader = Keypair.generate();
    await airdrop(trader.publicKey, 60);
    await buy(trader, mint, curveState, solInForEffective(FILL_EFFECTIVE));

    const state = await program.account.curveStateAccount.fetch(curveState);
    expect(state.graduated).to.equal(false);
    expect(Number(state.solReserve.toString())).to.be.greaterThanOrEqual(
      Number(GRADUATION_THRESHOLD_SOL.toString())
    );

    const vaultInfo = (await connection.getAccountInfo(curveState, "confirmed"))!;
    const vaultBefore = BigInt(vaultInfo.lamports);
    const rentMin = BigInt(
      await connection.getMinimumBalanceForRentExemption(vaultInfo.data.length)
    );
    // Sanity: the vault holds the real raise (~55.56 SOL), NOT the 85 SOL the
    // reserve ledger claims. Subtracting the 30 SOL virtual reserve from this
    // vault is exactly the F1 bug: it strands ~30 SOL of real buyer money.
    const realDeposits = vaultBefore - rentMin;
    expect(Number(realDeposits)).to.be.greaterThan(50 * LAMPORTS_PER_SOL);
    expect(Number(realDeposits)).to.be.lessThan(60 * LAMPORTS_PER_SOL);

    // Graduate and measure what the creator actually receives.
    const creatorSolBefore = await connection.getBalance(creator, "confirmed");
    await graduate(mint, curveState);
    const creatorSolAfter = await connection.getBalance(creator, "confirmed");

    // F1 acceptance 1: the vault is left at exactly its rent-exempt floor,
    // NOT at the 30 SOL virtual reserve (the pre-fix code stranded ~30 SOL
    // of real buyer deposits here forever).
    const vaultAfter = (await connection.getAccountInfo(curveState, "confirmed"))!.lamports;
    expect(
      vaultAfter,
      "vault after graduation must equal the rent-exempt floor, not 30 SOL"
    ).to.equal(Number(rentMin));

    // F1 acceptance 2: the creator received the full real deposits (~55.56
    // SOL). The pre-fix code paid only vault - 30 SOL (~25.56 SOL). Tolerance
    // covers the graduate tx fee (5000 lamports) and, if the creator's ATA
    // was created on demand, its rent.
    const creatorDelta = BigInt(creatorSolAfter - creatorSolBefore);
    expect(creatorDelta <= realDeposits).to.equal(true);
    expect(
      creatorDelta >= realDeposits - 3_000_000n,
      "creator must receive vault - rent floor (~55.56 SOL), not vault - 30 SOL"
    ).to.equal(true);

    // The curve is closed and flagged graduated; nothing else moved.
    const after = await program.account.curveStateAccount.fetch(curveState);
    expect(after.graduated).to.equal(true);
  });

  it("F2: a pre-funded data-less grief account at the buyer ATA address is recovered; the first buy succeeds", async () => {
    const { mint, curveState } = await createToken(
      NONCE(),
      "F2 Grief ATA",
      "F2G",
      "https://example.com/f2.json",
      { autoMigrate: false, lockLp: true }
    );

    const victim = Keypair.generate();
    await airdrop(victim.publicKey, 10);
    const attacker = Keypair.generate();
    await airdrop(attacker.publicKey, 1);

    // Derive the victim's Token-2022 ATA and grief it: transfer the rent-
    // exempt minimum to the derived address so it becomes a data-less system
    // account. Nobody holds the secret key for an ATA address, so without the
    // idempotent recovery this grief is permanent.
    const victimAta = await getAssociatedTokenAddress(
      mint,
      victim.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    expect(await connection.getAccountInfo(victimAta, "confirmed")).to.equal(null);

    const griefLamports = await connection.getMinimumBalanceForRentExemption(0);
    const griefTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: attacker.publicKey,
        toPubkey: victimAta,
        // rent-exempt for 0 bytes (~0.0009 SOL) + headroom: any lamports at
        // the derived address create the data-less system account.
        lamports: Math.floor(0.02 * LAMPORTS_PER_SOL),
      })
    );
    griefTx.feePayer = attacker.publicKey;
    // Confirm at "confirmed": the finalized horizon on the local validator
    // lags ~32 slots behind, so a finalized-confirmed tx is not yet readable
    // at the confirmed horizon when this returns.
    const griefSig = await connection.sendTransaction(griefTx, [attacker]);
    await connection.confirmTransaction(griefSig, "confirmed");

    const griefInfo = (await connection.getAccountInfo(victimAta, "confirmed"))!;
    expect(griefInfo.owner.toString()).to.equal(SystemProgram.programId.toString());
    expect(griefInfo.data.length).to.equal(0);
    expect(griefInfo.lamports).to.be.greaterThanOrEqual(griefLamports);

    // The victim's first buy must succeed and recover the account.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- captures the thrown anchor error, shape is opaque to the test
    let buyThrown: any;
    try {
      await buy(victim, mint, curveState, SOL);
    } catch (e) {
      buyThrown = e;
    }
    expect(
      buyThrown,
      "buy must succeed even when the ATA address was griefed with a data-less system account"
    ).to.not.exist;

    // The grief is recovered: the ATA is now a Token-2022 token account owned
    // by the token program, holding the minted tokens, and rent-exempt for
    // its actual (170-byte) size. getAccount throws if the owner is not
    // Token-2022, so success proves the recovery.
    const ata = await getAccount(connection, victimAta, "confirmed", TOKEN_2022_PROGRAM_ID);
    expect(ata.amount.toString()).to.not.equal("0");
    const ataInfo = (await connection.getAccountInfo(victimAta, "confirmed"))!;
    expect(ataInfo.owner.toString()).to.equal(TOKEN_2022_PROGRAM_ID.toString());
    const ataRent = await connection.getMinimumBalanceForRentExemption(
      ataInfo.data.length
    );
    expect(ataInfo.lamports).to.be.greaterThanOrEqual(ataRent);

    // The buy landed normally: mint supply grew and the curve is still open.
    const state = await program.account.curveStateAccount.fetch(curveState);
    expect(state.graduated).to.equal(false);
    expect(Number(state.supplyOut.toString())).to.be.greaterThan(0);
  });
});
