import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  getMint,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import { deserializeMetadata } from "@metaplex-foundation/mpl-token-metadata";
import { publicKey as umiPublicKey } from "@metaplex-foundation/umi";
import type { Pumpfun } from "../target/types/pumpfun";
import {
  DECIMALS,
  TOTAL_SUPPLY,
  VIRTUAL_SOL_RESERVE,
  VIRTUAL_TOKEN_RESERVE,
  FEE_BPS,
  GRADUATION_THRESHOLD_SOL,
  DEFAULT_AUTO_MIGRATE,
  DEFAULT_LOCK_LP,
} from "../lib/params";

describe("pumpfun (M1)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Pumpfun as Program<Pumpfun>;
  const connection = provider.connection;

  const METAPLEX_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

  const MINT_SEED = Buffer.from("mint");
  const CURVE_SEED = Buffer.from("curve");
  const MINT_AUTHORITY_SEED = Buffer.from("mint_authority");
  const METADATA_SEED = Buffer.from("metadata");
  const SOL = new BN(LAMPORTS_PER_SOL);

  const mintPda = (creator: PublicKey, nonce: BN): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [MINT_SEED, creator.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

  const curvePda = (mint: PublicKey): [PublicKey, number] =>
    PublicKey.findProgramAddressSync([CURVE_SEED, mint.toBuffer()], program.programId);

  const mintAuthorityPda = (mint: PublicKey): [PublicKey, number] =>
    PublicKey.findProgramAddressSync([MINT_AUTHORITY_SEED, mint.toBuffer()], program.programId);

  const metadataPda = (mint: PublicKey): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [METADATA_SEED, METAPLEX_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      METAPLEX_PROGRAM_ID
    );

  // Stage-1 curve math mirrored in BigInt for assertions:
  // effective = input * (10000 - fee_bps) / 10000
  // buy:  token_out = token_reserve * effective / (sol_reserve + effective)
  // sell: sol_out   = sol_reserve * effective / (token_reserve + effective)
  // M3: the buy instruction carries the recorded creator's wallet + ATA
  // (validated by the program on every buy; used by auto-graduation).
  const creatorBuyAccounts = (mint: PublicKey) => ({
    creatorAccount: provider.wallet.publicKey,
    creatorAta: getAssociatedTokenAddressSync(
      mint,
      provider.wallet.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    ),
  });

  const curveBuy = (
    solIn: bigint,
    solReserve: bigint,
    tokenReserve: bigint,
    feeBps: bigint
  ): { effective: bigint; tokenOut: bigint } => {
    const effective = (solIn * (10000n - feeBps)) / 10000n;
    const tokenOut = (tokenReserve * effective) / (solReserve + effective);
    return { effective, tokenOut };
  };

  const curveSell = (
    tokenIn: bigint,
    solReserve: bigint,
    tokenReserve: bigint,
    feeBps: bigint
  ): { effective: bigint; solOut: bigint } => {
    const effective = (tokenIn * (10000n - feeBps)) / 10000n;
    const solOut = (solReserve * effective) / (tokenReserve + effective);
    return { effective, solOut };
  };

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
    const creator = provider.wallet.publicKey;
    const [mint] = mintPda(creator, nonce);
    const [curveState] = curvePda(mint);
    const [mintAuthority] = mintAuthorityPda(mint);
    const [metadata] = metadataPda(mint);
    const sig = await program.methods
      .create(
        nonce,
        name,
        symbol,
        uri,
        opts?.autoMigrate ?? DEFAULT_AUTO_MIGRATE,
        opts?.lockLp ?? DEFAULT_LOCK_LP
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
    return { creator, mint, curveState, mintAuthority, metadata };
  }

  let nonceCounter = 0;
  const NONCE = () => new BN(Date.now() + nonceCounter++); // unique per test: the mint PDA is ["mint", creator, nonce]

  it("create: mint 6 decimals, PDA mint authority, freeze authority None, locked curve state, metadata exists", async () => {
    const name = "Test Token";
    const symbol = "TEST";
    const uri = "https://example.com/test-token.json";
    const { mint, curveState, mintAuthority, metadata } = await createToken(NONCE(), name, symbol, uri);

    const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    expect(mintInfo.decimals).to.equal(DECIMALS);
    expect(mintInfo.mintAuthority!.toString()).to.equal(mintAuthority.toString());
    expect(mintInfo.freezeAuthority).to.be.null;
    expect(mintInfo.supply.toString()).to.equal("0");

    const state = await program.account.curveStateAccount.fetch(curveState);
    expect(state.solReserve.toString()).to.equal(VIRTUAL_SOL_RESERVE.toString());
    expect(state.tokenReserve.toString()).to.equal(VIRTUAL_TOKEN_RESERVE.toString());
    expect(state.feeBps.toString()).to.equal(FEE_BPS.toString());
    expect(state.supplyOut.toString()).to.equal("0");
    expect(state.totalSupply.toString()).to.equal(TOTAL_SUPPLY.toString());
    expect(state.graduationThresholdSol.toString()).to.equal(GRADUATION_THRESHOLD_SOL.toString());
    expect(state.decimals).to.equal(DECIMALS);

    const vault = await connection.getAccountInfo(curveState);
    expect(vault).to.not.be.null;
    const rent = await connection.getMinimumBalanceForRentExemption(vault!.data.length);
    expect(vault!.lamports).to.be.greaterThanOrEqual(rent); // rent-exempt by construction

    // Metaplex metadata account exists with the right name/symbol/uri.
    const metaInfo = await connection.getAccountInfo(metadata);
    expect(metaInfo).to.not.be.null;
    expect(metaInfo!.owner.toString()).to.equal(METAPLEX_PROGRAM_ID.toString());
    const decoded = deserializeMetadata({
      publicKey: umiPublicKey(metadata.toBase58()),
      executable: false,
      owner: umiPublicKey(METAPLEX_PROGRAM_ID.toBase58()),
      lamports: BigInt(metaInfo!.lamports),
      data: metaInfo!.data,
    } as unknown as Parameters<typeof deserializeMetadata>[0]);
    expect(decoded.name).to.equal(name);
    expect(decoded.symbol).to.equal(symbol);
    expect(decoded.uri).to.equal(uri);
  });

  it("buy: mints math output, vault gains exactly sol_in, reserves update, price rises", async () => {
    const { mint, curveState } = await createToken(NONCE(), "Buy Token", "BUY", "https://example.com/buy.json");

    const buyer = Keypair.generate();
    await airdrop(buyer.publicKey, 10);
    const buyerAta = await getAssociatedTokenAddress(
      mint,
      buyer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    const stateBefore = await program.account.curveStateAccount.fetch(curveState);
    const vaultBefore = (await connection.getAccountInfo(curveState))!.lamports;
    const priceBefore = stateBefore.solReserve.div(stateBefore.tokenReserve);

    const solIn = SOL; // 1 SOL
    const sig = await program.methods
      .buy(solIn)
      .accounts({
        buyer: buyer.publicKey,
        mint,
        curveState,
        buyerAta,
        ...creatorBuyAccounts(mint),
        mintAuthority: mintAuthorityPda(mint)[0],
        systemProgram: SystemProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();
    await connection.confirmTransaction(sig, "confirmed");

    const { effective, tokenOut } = curveBuy(
      BigInt(solIn.toString()),
      BigInt(stateBefore.solReserve.toString()),
      BigInt(stateBefore.tokenReserve.toString()),
      BigInt(stateBefore.feeBps.toString())
    );

    const ata = await getAccount(connection, buyerAta, "confirmed", TOKEN_2022_PROGRAM_ID);
    expect(ata.amount.toString()).to.equal(tokenOut.toString());
    const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    expect(mintInfo.supply.toString()).to.equal(tokenOut.toString());

    const vaultAfter = (await connection.getAccountInfo(curveState))!.lamports;
    expect(vaultAfter - vaultBefore).to.equal(solIn.toNumber());

    const stateAfter = await program.account.curveStateAccount.fetch(curveState);
    expect(stateAfter.solReserve.toString()).to.equal(
      (BigInt(stateBefore.solReserve.toString()) + effective).toString()
    );
    expect(stateAfter.tokenReserve.toString()).to.equal(
      (BigInt(stateBefore.tokenReserve.toString()) - tokenOut).toString()
    );
    expect(stateAfter.supplyOut.toString()).to.equal(tokenOut.toString());

    const priceAfter = stateAfter.solReserve.div(stateAfter.tokenReserve);
    expect(priceAfter.gt(priceBefore)).to.be.true;
  });

  it("sell: pays math output in SOL, burns tokens, reserves update, price falls", async () => {
    const { mint, curveState } = await createToken(NONCE(), "Sell Token", "SELL", "https://example.com/sell.json");

    const trader = Keypair.generate();
    await airdrop(trader.publicKey, 10);
    const traderAta = await getAssociatedTokenAddress(
      mint,
      trader.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    // Buy 1 SOL first so the trader holds tokens and the vault holds real SOL.
    const buySig = await program.methods
      .buy(SOL)
      .accounts({
        buyer: trader.publicKey,
        mint,
        curveState,
        buyerAta: traderAta,
        ...creatorBuyAccounts(mint),
        mintAuthority: mintAuthorityPda(mint)[0],
        systemProgram: SystemProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([trader])
      .rpc();
    await connection.confirmTransaction(buySig, "confirmed");

    const ata = await getAccount(connection, traderAta, "confirmed", TOKEN_2022_PROGRAM_ID);
    const tokenIn = new BN(ata.amount.toString());

    const stateBefore = await program.account.curveStateAccount.fetch(curveState);
    const vaultBefore = (await connection.getAccountInfo(curveState))!.lamports;
    const priceBefore = stateBefore.solReserve.div(stateBefore.tokenReserve);
    const solBefore = await connection.getBalance(trader.publicKey, "confirmed");

    const sig = await program.methods
      .sell(tokenIn)
      .accounts({
        seller: trader.publicKey,
        mint,
        curveState,
        sellerAta: traderAta,
        systemProgram: SystemProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([trader])
      .rpc();
    await connection.confirmTransaction(sig, "confirmed");

    const { effective, solOut } = curveSell(
      BigInt(tokenIn.toString()),
      BigInt(stateBefore.solReserve.toString()),
      BigInt(stateBefore.tokenReserve.toString()),
      BigInt(stateBefore.feeBps.toString())
    );

    const solAfter = await connection.getBalance(trader.publicKey, "confirmed");
    expect(BigInt(solAfter - solBefore)).to.equal(solOut);

    // Tokens burned: the ATA is empty.
    const ataAfter = await getAccount(connection, traderAta, "confirmed", TOKEN_2022_PROGRAM_ID);
    expect(ataAfter.amount.toString()).to.equal("0");

    const vaultAfter = (await connection.getAccountInfo(curveState))!.lamports;
    expect(BigInt(vaultBefore - vaultAfter)).to.equal(solOut);

    const stateAfter = await program.account.curveStateAccount.fetch(curveState);
    expect(stateAfter.solReserve.toString()).to.equal(
      (BigInt(stateBefore.solReserve.toString()) - solOut).toString()
    );
    expect(stateAfter.tokenReserve.toString()).to.equal(
      (BigInt(stateBefore.tokenReserve.toString()) + effective).toString()
    );
    // supply_out is cumulative minted and is untouched by the sell.
    expect(stateAfter.supplyOut.toString()).to.equal(stateBefore.supplyOut.toString());

    const priceAfter = stateAfter.solReserve.div(stateAfter.tokenReserve);
    expect(priceAfter.lt(priceBefore)).to.be.true;
  });

  it("buy(0) is rejected with the custom ZeroAmount error, not a panic", async () => {
    const { mint, curveState } = await createToken(NONCE(), "Zero", "ZERO", "https://example.com/zero.json");
    const buyer = Keypair.generate();
    await airdrop(buyer.publicKey, 10);
    const buyerAta = await getAssociatedTokenAddress(mint, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- captures the thrown anchor error, shape is opaque to the test
    let thrown: any;
    try {
      await program.methods
        .buy(new BN(0))
        .accounts({
          buyer: buyer.publicKey,
          mint,
          curveState,
          buyerAta,
          ...creatorBuyAccounts(mint),
          mintAuthority: mintAuthorityPda(mint)[0],
          systemProgram: SystemProgram.programId,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([buyer])
        .rpc();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.exist;
    const parsed = anchor.AnchorError.parse(thrown.logs);
    expect(parsed).to.not.be.null;
    expect(parsed!.error.errorCode.code).to.equal("ZeroAmount");
  });

  it("sell(0) is rejected with the custom ZeroAmount error, not a panic", async () => {
    const { mint, curveState } = await createToken(NONCE(), "ZeroSell", "ZS", "https://example.com/zerosell.json");
    const seller = Keypair.generate();
    const sellerAta = await getAssociatedTokenAddress(mint, seller.publicKey, false, TOKEN_2022_PROGRAM_ID);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- captures the thrown anchor error, shape is opaque to the test
    let thrown: any;
    try {
      await program.methods
        .sell(new BN(0))
        .accounts({
          seller: seller.publicKey,
          mint,
          curveState,
          sellerAta,
          systemProgram: SystemProgram.programId,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([seller])
        .rpc();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.exist;
    const parsed = anchor.AnchorError.parse(thrown.logs);
    expect(parsed).to.not.be.null;
    expect(parsed!.error.errorCode.code).to.equal("ZeroAmount");
  });

  it("buy(huge) errors and never panics, state unchanged", async () => {
    const { mint, curveState } = await createToken(NONCE(), "Huge", "HUGE", "https://example.com/huge.json");
    const buyer = Keypair.generate();
    await airdrop(buyer.publicKey, 10);
    const buyerAta = await getAssociatedTokenAddress(mint, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);

    const stateBefore = await program.account.curveStateAccount.fetch(curveState);
    const vaultBefore = (await connection.getAccountInfo(curveState))!.lamports;

    // u64::MAX lamports: far beyond any balance, must error, never panic.
    const huge = new BN("18446744073709551615");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- captures the thrown anchor error, shape is opaque to the test
    let thrown: any;
    try {
      await program.methods
        .buy(huge)
        .accounts({
          buyer: buyer.publicKey,
          mint,
          curveState,
          buyerAta,
          ...creatorBuyAccounts(mint),
          mintAuthority: mintAuthorityPda(mint)[0],
          systemProgram: SystemProgram.programId,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([buyer])
        .rpc();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.exist;

    // A failed transaction reverts: reserves and vault are untouched.
    const stateAfter = await program.account.curveStateAccount.fetch(curveState);
    expect(stateAfter.solReserve.toString()).to.equal(stateBefore.solReserve.toString());
    expect(stateAfter.tokenReserve.toString()).to.equal(stateBefore.tokenReserve.toString());
    expect(stateAfter.supplyOut.toString()).to.equal(stateBefore.supplyOut.toString());
    const vaultAfter = (await connection.getAccountInfo(curveState))!.lamports;
    expect(vaultAfter).to.equal(vaultBefore);
  });

  it("sell-that-drains is rejected with the custom InsufficientLiquidity error", async () => {
    const { mint, curveState } = await createToken(NONCE(), "Drain", "DRAIN", "https://example.com/drain.json");
    const seller = Keypair.generate();
    const sellerAta = await getAssociatedTokenAddress(mint, seller.publicKey, false, TOKEN_2022_PROGRAM_ID);

    // effective = 1_100_000_000 * 9900 / 10000 = 1_089_000_000 >= 1_073_000_000
    // (the virtual token reserve), so the curve math must reject the sell
    // before any burn or transfer happens.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- captures the thrown anchor error, shape is opaque to the test
    let thrown: any;
    try {
      await program.methods
        .sell(new BN("1100000000"))
        .accounts({
          seller: seller.publicKey,
          mint,
          curveState,
          sellerAta,
          systemProgram: SystemProgram.programId,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([seller])
        .rpc();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.exist;
    const parsed = anchor.AnchorError.parse(thrown.logs);
    expect(parsed).to.not.be.null;
    expect(parsed!.error.errorCode.code).to.equal("InsufficientLiquidity");
  });

  it("round trip: buy then sell loses only the fee plus rounding", async () => {
    const { mint, curveState } = await createToken(NONCE(), "Round", "RND", "https://example.com/round.json");

    const trader = Keypair.generate();
    await airdrop(trader.publicKey, 10);
    const traderAta = await getAssociatedTokenAddress(mint, trader.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const mintAuthority = mintAuthorityPda(mint)[0];

    const buySig = await program.methods
      .buy(SOL)
      .accounts({
        buyer: trader.publicKey,
        mint,
        curveState,
        buyerAta: traderAta,
        ...creatorBuyAccounts(mint),
        mintAuthority,
        systemProgram: SystemProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([trader])
      .rpc();
    await connection.confirmTransaction(buySig, "confirmed");

    const ata = await getAccount(connection, traderAta, "confirmed", TOKEN_2022_PROGRAM_ID);
    const tokenIn = new BN(ata.amount.toString());

    const stateBefore = await program.account.curveStateAccount.fetch(curveState);
    const solBefore = await connection.getBalance(trader.publicKey, "confirmed");

    const sellSig = await program.methods
      .sell(tokenIn)
      .accounts({
        seller: trader.publicKey,
        mint,
        curveState,
        sellerAta: traderAta,
        systemProgram: SystemProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([trader])
      .rpc();
    await connection.confirmTransaction(sellSig, "confirmed");

    const solAfter = await connection.getBalance(trader.publicKey, "confirmed");
    const solBack = BigInt(solAfter - solBefore);

    // The 1% input-side fee on both legs plus integer rounding: strictly less.
    expect(solBack < BigInt(SOL.toString())).to.be.true;

    // Exact expected value straight from the curve math module (the sell runs
    // against the post-buy reserves).
    const { solOut } = curveSell(
      BigInt(tokenIn.toString()),
      BigInt(stateBefore.solReserve.toString()),
      BigInt(stateBefore.tokenReserve.toString()),
      BigInt(stateBefore.feeBps.toString())
    );
    expect(solBack).to.equal(solOut);

    // Exact expected reserve: the buy added effective (0.99 SOL after fee) to
    // the virtual 30 SOL, the sell removed solOut. The fee stayed in the curve.
    const { effective: effectiveBuy } = curveBuy(
      BigInt(SOL.toString()),
      BigInt(VIRTUAL_SOL_RESERVE.toString()),
      BigInt(VIRTUAL_TOKEN_RESERVE.toString()),
      BigInt(FEE_BPS.toString())
    );
    const stateAfter = await program.account.curveStateAccount.fetch(curveState);
    expect(stateAfter.solReserve.toString()).to.equal(
      (BigInt(VIRTUAL_SOL_RESERVE.toString()) + effectiveBuy - solOut).toString()
    );
    expect(stateAfter.supplyOut.toString()).to.equal(stateBefore.supplyOut.toString());
    // The fees stayed in the curve, so the post-round-trip price (27.97 after
    // truncation) is at least the initial virtual price (27.96 truncated to
    // 27); the exact reserve assertion above is the precise check.
    const priceAfter = stateAfter.solReserve.div(stateAfter.tokenReserve);
    const initialPrice = new BN(VIRTUAL_SOL_RESERVE.toString()).div(new BN(VIRTUAL_TOKEN_RESERVE.toString()));
    expect(priceAfter.gte(initialPrice)).to.be.true;
  });
});
