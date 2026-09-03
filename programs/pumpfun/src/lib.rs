//! Milestone M3: graduation / client-driven migration to PumpSwap.
//!
//! On top of the M1 core (create/buy/sell), M3 adds:
//!
//!   4. `graduate(creator, mint, curve_state, ...)`: creator-only, finalizes
//!      a filled curve: releases the real SOL (vault lamports minus the
//!      vault's rent-exempt floor) to the recorded creator, mints the
//!      remaining supply to the creator's ATA, revokes the mint authority,
//!      and flags the curve graduated. Buy and sell revert afterwards.
//!
//! Graduation has two trigger modes, decided per token at create() time:
//!
//!   - auto_migrate = false: a creator-only `graduate` instruction. Only the
//!     recorded creator may call it; anyone else reverts.
//!   - auto_migrate = true: the buy instruction that fills the curve
//!     (sol_reserve >= GRADUATION_THRESHOLD_SOL after the buy) performs the
//!     same graduation internally. No separate call needed.
//!
//! The migration itself is CLIENT-DRIVEN (Option B, confirmed by product):
//! the program never CPIs into PumpSwap. An off-chain script (lib/migrate.ts +
//! scripts/migrate-pumpswap.mjs) wraps the released SOL to WSOL and seeds a
//! PumpSwap pool via the official @pump-fun/pump-swap-sdk, honoring the
//! per-token lock_lp flag (burn LP when true, leave it with the creator when
//! false).
//!
//! # PDA / seed scheme (documented per M1)
//!
//! - `mint`: PDA with seeds `["mint", creator, nonce_le_bytes]`. `nonce` is a
//!   caller-chosen u64 (e.g. Unix time) that makes the address unique per
//!   creator; the client retries with a fresh nonce on the (astronomically
//!   unlikely) collision. The mint is created via `create_account` +
//!   `initialize_mint2` CPIs signed by the mint PDA bump.
//! - `mint_authority`: PDA with seeds `["mint_authority", mint]`. Set as the
//!   mint authority at creation and used as the signer for every `mint_to`
//!   CPI. Only the program can mint; freeze authority is None (revoked),
//!   matching pump.fun's non-freezable model. Graduation revokes this
//!   authority entirely (set to None) so no instruction can ever mint again.
//! - `curve_state`: PDA with seeds `["curve", mint]`. Holds the locked curve
//!   parameters, the per-token migration options (creator, graduated,
//!   auto_migrate, lock_lp), and the live reserves and `supply_out`, and is
//!   the SOL vault receiving buy proceeds (rent-exempt at creation).
//! - `metadata`: PDA of the mpl-token-metadata program with seeds
//!   `["metadata", mpl_program_id, mint]`, created via the metadata CPI.
//!
//! # u64/u128 boundary
//!
//! All curve math runs in u128 (see `curve_math.rs`). SPL amounts and the
//! on-chain account fields are u64. Every u64 -> u128 widening is lossless;
//! every u128 -> u64 narrowing goes through `u64::try_from` with a dedicated
//! `AmountOverflow` error, and all conversions happen BEFORE any account
//! mutation so a failed trade can never leave half-written state (the
//! transaction is atomic anyway).
//!
//! # Metaplex metadata CPI
//!
//! The metadata CPI is implemented against the real mpl-token-metadata program
//! (id `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s`, cloned into the local
//! validator from mainnet for tests) using the kinobi-generated
//! `CreateMetadataAccountV3Cpi` from mpl-token-metadata 5.1.2-alpha.2. The
//! mint + curve are the must-have core; if the metadata leg ever proves
//! disproportionate to maintain, the documented fallback is to stub it behind
//! a TODO and create the metadata off-chain in M4, which does not touch the
//! curve state.

use anchor_lang::{prelude::*, solana_program::program_pack::Pack, system_program};
use anchor_spl::{
    associated_token::{self, get_associated_token_address_with_program_id, AssociatedToken},
    metadata::mpl_token_metadata,
    token_2022::{self, spl_token_2022, Token2022},
};

mod curve_math;
mod params;

use crate::curve_math::{CurveError, CurveState};
use crate::params as P;

declare_id!("BTE4vdMyUSbvgyyutBWYJsrhxj8XtCHQPjMk4Sfin3xu");

/// PDA seed prefix for the mint.
pub const MINT_SEED: &[u8] = b"mint";
/// PDA seed prefix for the curve state / SOL vault account.
pub const CURVE_SEED: &[u8] = b"curve";
/// PDA seed prefix for the per-mint mint authority.
pub const MINT_AUTHORITY_SEED: &[u8] = b"mint_authority";
/// PDA seed prefix (as bytes) of the mpl-token-metadata metadata account.
pub const METADATA_SEED: &[u8] = b"metadata";
/// The Sysvar1nstructions sysvar address, required by the mpl CreateV1 CPI.
pub const INSTRUCTIONS_SYSVAR_ID: Pubkey =
    pubkey!("Sysvar1nstructions1111111111111111111111111");

/// Maximum length of the token name accepted by `create`. Unit: bytes.
pub const MAX_NAME_LEN: usize = 32;
/// Maximum length of the token symbol accepted by `create`. Unit: bytes.
pub const MAX_SYMBOL_LEN: usize = 10;
/// Maximum length of the metadata URI accepted by `create`. Unit: bytes.
pub const MAX_URI_LEN: usize = 200;

#[program]
pub mod pumpfun {
    use super::*;

    /// Creates the Token-2022 mint (PDA), the curve_state PDA / SOL vault, and
    /// the Metaplex metadata account. `nonce` disambiguates multiple tokens
    /// from the same creator; the mint PDA is `["mint", creator, nonce]`.
    pub fn create(
        ctx: Context<Create>,
        nonce: u64,
        name: String,
        symbol: String,
        uri: String,
        auto_migrate: bool,
        lock_lp: bool,
    ) -> Result<()> {
        require!(
            name.as_bytes().len() <= MAX_NAME_LEN,
            CurveErrorCode::NameTooLong
        );
        require!(
            symbol.as_bytes().len() <= MAX_SYMBOL_LEN,
            CurveErrorCode::SymbolTooLong
        );
        require!(
            uri.as_bytes().len() <= MAX_URI_LEN,
            CurveErrorCode::UriTooLong
        );

        // 1. Create the mint account: rent-exempt, exactly sized for a
        //    no-extension Token-2022 mint, owned by the token program. The mint
        //    is a PDA, so the system create_account CPI is signed with the mint
        //    bump instead of a keypair signature.
        let rent = Rent::get()?;
        let mint_space = spl_token_2022::state::Mint::LEN;
        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                system_program::CreateAccount {
                    from: ctx.accounts.creator.to_account_info(),
                    to: ctx.accounts.mint.to_account_info(),
                },
                &[&[
                    MINT_SEED,
                    ctx.accounts.creator.key().as_ref(),
                    &nonce.to_le_bytes(),
                    &[ctx.bumps.mint],
                ]],
            ),
            rent.minimum_balance(mint_space),
            mint_space as u64,
            &ctx.accounts.token_2022_program.key(),
        )?;

        // 2. Initialize the mint: DECIMALS decimals, mint authority = the mint
        //    authority PDA, freeze authority = None (revoked). Only the program
        //    can mint; the token is non-freezable, matching pump.fun.
        token_2022::initialize_mint2(
            CpiContext::new(
                ctx.accounts.token_2022_program.key(),
                token_2022::InitializeMint2 {
                    mint: ctx.accounts.mint.to_account_info(),
                },
            ),
            P::DECIMALS,
            &ctx.accounts.mint_authority.key(),
            None,
        )?;

        // 3. Seed the curve state with the locked parameters from params.rs
        //    and the per-token migration options. `init` created the PDA
        //    rent-exempt; the vault is ready to receive buy proceeds.
        let curve_state = &mut ctx.accounts.curve_state;
        curve_state.creator = ctx.accounts.creator.key();
        curve_state.graduated = false;
        curve_state.auto_migrate = auto_migrate;
        curve_state.lock_lp = lock_lp;
        curve_state.sol_reserve = P::VIRTUAL_SOL_RESERVE;
        curve_state.token_reserve = P::VIRTUAL_TOKEN_RESERVE;
        curve_state.fee_bps = P::FEE_BPS;
        curve_state.supply_out = 0;
        curve_state.total_supply = P::TOTAL_SUPPLY;
        curve_state.graduation_threshold_sol = P::GRADUATION_THRESHOLD_SOL;
        curve_state.decimals = P::DECIMALS;

        // 4. Create the Metaplex metadata account via the CreateV1 CPI (the
        //    "new API"). The mainnet mpl-token-metadata program rejects the
        //    legacy create_metadata_account_v3 CPI for Token-2022 mints with
        //    error 0x99 ("Instruction not supported for ProgrammableNonFungible
        //    assets"); CreateV1 with token_standard = Fungible is the supported
        //    path. The update authority is the mint-authority PDA, so metadata
        //    edits require the program. The metadata PDA is derived by the
        //    metadata program from ["metadata", mpl_id, mint].
        mpl_token_metadata::instructions::CreateV1Cpi::new(
            &ctx.accounts.mpl_token_metadata_program.to_account_info(),
            mpl_token_metadata::instructions::CreateV1CpiAccounts {
                metadata: &ctx.accounts.metadata.to_account_info(),
                master_edition: None,
                // The mint already exists, so it does not need to sign.
                mint: (&ctx.accounts.mint.to_account_info(), false),
                // The mint authority PDA signs via the invoke_signed seeds.
                authority: &ctx.accounts.mint_authority.to_account_info(),
                payer: &ctx.accounts.creator.to_account_info(),
                // creators is None, so the update authority does not need to
                // sign for this call; the PDA controls future updates.
                update_authority: (&ctx.accounts.mint_authority.to_account_info(), false),
                system_program: &ctx.accounts.system_program.to_account_info(),
                sysvar_instructions: &ctx.accounts.sysvar_instructions.to_account_info(),
                // The mint is owned by Token-2022, so the token program account
                // must be the Token-2022 program.
                spl_token_program: Some(&ctx.accounts.token_2022_program.to_account_info()),
            },
            mpl_token_metadata::instructions::CreateV1InstructionArgs {
                name,
                symbol,
                uri,
                seller_fee_basis_points: 0,
                creators: None,
                primary_sale_happened: false,
                is_mutable: true,
                token_standard: mpl_token_metadata::types::TokenStandard::Fungible,
                collection: None,
                uses: None,
                collection_details: None,
                rule_set: None,
                decimals: Some(P::DECIMALS),
                print_supply: None,
            },
        )
        .invoke_signed(&[&[
            MINT_AUTHORITY_SEED,
            ctx.accounts.mint.key().as_ref(),
            &[ctx.bumps.mint_authority],
        ]])
        .map_err(|_| CurveErrorCode::MetadataCpiFailed)?;

        Ok(())
    }

    /// Buys tokens with `sol_in` lamports per the curve math module.
    ///
    /// Trading is closed after graduation (reverts with `AlreadyGraduated`).
    /// When the curve opted into auto-migration, the buy that pushes the SOL
    /// reserve to the graduation threshold also runs the graduation flow in
    /// the same instruction (see `graduate_impl`).
    pub fn buy(ctx: Context<Buy>, sol_in: u64) -> Result<()> {
        // Gate: once graduated, the curve is closed for trading.
        require!(
            !ctx.accounts.curve_state.graduated,
            CurveErrorCode::AlreadyGraduated
        );
        // The buyer being a signer is enforced by the Accounts struct (Signer).
        require!(sol_in > 0, CurveErrorCode::ZeroAmount);

        // The auto-graduation accounts must point at the recorded creator and
        // their real ATA; validated on every buy so a fill buy cannot redirect
        // the released SOL or the remaining supply to an attacker.
        require!(
            ctx.accounts.creator_account.key() == ctx.accounts.curve_state.creator,
            CurveErrorCode::NotCurveCreator
        );
        require!(
            ctx.accounts.creator_ata.key()
                == get_associated_token_address_with_program_id(
                    &ctx.accounts.curve_state.creator,
                    &ctx.accounts.mint.key(),
                    &ctx.accounts.token_2022_program.key(),
                ),
            CurveErrorCode::InvalidAssociatedTokenAccount
        );

        // Boundary: u64 -> u128 is a lossless widening into the curve math.
        let mut curve = CurveState {
            sol_reserve: ctx.accounts.curve_state.sol_reserve as u128,
            token_reserve: ctx.accounts.curve_state.token_reserve as u128,
            supply_out: ctx.accounts.curve_state.supply_out as u128,
            fee_bps: ctx.accounts.curve_state.fee_bps,
        };

        let token_out_raw = curve.buy(sol_in as u128)?;

        // Cap the mint at the locked total supply: a token can never mint more
        // than TOTAL_SUPPLY, even if the raw curve math would mint more at the
        // far end of the curve (past the point where supply_out approaches the
        // virtual token reserve). The reserve bookkeeping below is adjusted to
        // reflect the actual minted amount.
        let mintable = (ctx.accounts.curve_state.total_supply as u128)
            .checked_sub(curve.supply_out)
            .ok_or(CurveErrorCode::SupplyExhausted)?;
        let token_out = token_out_raw.min(mintable);
        if token_out == 0 {
            return Err(CurveErrorCode::SupplyExhausted.into());
        }
        // If the cap bound, undo the excess the raw math already applied.
        let excess = token_out_raw - token_out; // capped <= raw, so no overflow
        if excess > 0 {
            curve.token_reserve = curve
                .token_reserve
                .checked_add(excess)
                .ok_or(CurveErrorCode::Overflow)?;
            curve.supply_out = curve
                .supply_out
                .checked_sub(excess)
                .ok_or(CurveErrorCode::Overflow)?;
        }

        // Boundary: u128 -> u64. Mint amounts and stored reserves are SPL u64;
        // anything that does not fit is rejected with a clear error before any
        // account is touched, never silently truncated.
        let token_out_u64: u64 =
            u64::try_from(token_out).map_err(|_| CurveErrorCode::AmountOverflow)?;
        let sol_reserve_u64: u64 =
            u64::try_from(curve.sol_reserve).map_err(|_| CurveErrorCode::AmountOverflow)?;
        let token_reserve_u64: u64 =
            u64::try_from(curve.token_reserve).map_err(|_| CurveErrorCode::AmountOverflow)?;
        let supply_out_u64: u64 =
            u64::try_from(curve.supply_out).map_err(|_| CurveErrorCode::AmountOverflow)?;

        // Move the SOL proceeds from the buyer into the curve_state vault PDA.
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.curve_state.to_account_info(),
                },
            ),
            sol_in,
        )?;

        // Create the buyer's ATA on demand (missing account is the only case).
        // The idempotent create recovers a pre-funded data-less system account
        // parked at the derived ATA address (an ATA grief) instead of
        // reverting: the associated-token program initializes it in place.
        if ctx.accounts.buyer_ata.data_is_empty() {
            associated_token::create_idempotent(CpiContext::new(
                ctx.accounts.associated_token_program.key(),
                associated_token::Create {
                    payer: ctx.accounts.buyer.to_account_info(),
                    associated_token: ctx.accounts.buyer_ata.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    token_program: ctx.accounts.token_2022_program.to_account_info(),
                },
            ))?;
        }

        // Mint the output tokens, authority = the mint-authority PDA, so the
        // minting is authorized by the program itself (PDA signer via seeds).
        token_2022::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_2022_program.key(),
                token_2022::MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.buyer_ata.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                &[&[
                    MINT_AUTHORITY_SEED,
                    ctx.accounts.mint.key().as_ref(),
                    &[ctx.bumps.mint_authority],
                ]],
            ),
            token_out_u64,
        )?;

        // Boundary: write the pre-converted u64 reserves back. All four values
        // were validated above, so this can never truncate.
        // curve_info is cloned up front: the auto-graduation path moves
        // lamports through the vault AccountInfo while curve_state mutably
        // borrows the account data, so the two cannot alias the same &mut.
        let curve_info = ctx.accounts.curve_state.to_account_info();
        let curve_state = &mut ctx.accounts.curve_state;
        curve_state.sol_reserve = sol_reserve_u64;
        curve_state.token_reserve = token_reserve_u64;
        curve_state.supply_out = supply_out_u64;

        // Auto-graduation: when the curve opted in and this buy pushed the SOL
        // reserve to the threshold, finalize the curve in the same instruction
        // (release real SOL to the creator, mint the remaining supply to their
        // ATA, revoke the mint authority, flag graduated). The creator_account
        // / creator_ata addresses were validated above.
        if curve_state.auto_migrate && curve_state.sol_reserve >= P::GRADUATION_THRESHOLD_SOL {
            graduate_impl(
                curve_state,
                &curve_info,
                &ctx.accounts.mint.to_account_info(),
                &ctx.accounts.creator_account.to_account_info(),
                &ctx.accounts.creator_ata.to_account_info(),
                &ctx.accounts.mint_authority.to_account_info(),
                ctx.bumps.mint_authority,
                &ctx.accounts.buyer.to_account_info(),
                &ctx.accounts.system_program.to_account_info(),
                &ctx.accounts.token_2022_program.to_account_info(),
                &ctx.accounts.associated_token_program.to_account_info(),
            )?;
        }

        Ok(())
    }

    /// Sells `token_in` raw tokens for lamports per the curve math module.
    pub fn sell(ctx: Context<Sell>, token_in: u64) -> Result<()> {
        // Gate: once graduated, the curve is closed for trading.
        require!(
            !ctx.accounts.curve_state.graduated,
            CurveErrorCode::AlreadyGraduated
        );
        // The seller being a signer is enforced by the Accounts struct (Signer).
        require!(token_in > 0, CurveErrorCode::ZeroAmount);

        // Boundary: u64 -> u128 is a lossless widening into the curve math.
        let mut curve = CurveState {
            sol_reserve: ctx.accounts.curve_state.sol_reserve as u128,
            token_reserve: ctx.accounts.curve_state.token_reserve as u128,
            supply_out: ctx.accounts.curve_state.supply_out as u128,
            fee_bps: ctx.accounts.curve_state.fee_bps,
        };

        let sol_out = curve.sell(token_in as u128)?;

        // Boundary: u128 -> u64, converted up front before any mutation.
        let sol_out_u64: u64 =
            u64::try_from(sol_out).map_err(|_| CurveErrorCode::AmountOverflow)?;
        let sol_reserve_u64: u64 =
            u64::try_from(curve.sol_reserve).map_err(|_| CurveErrorCode::AmountOverflow)?;
        let token_reserve_u64: u64 =
            u64::try_from(curve.token_reserve).map_err(|_| CurveErrorCode::AmountOverflow)?;
        let supply_out_u64: u64 =
            u64::try_from(curve.supply_out).map_err(|_| CurveErrorCode::AmountOverflow)?;

        // Burn the seller's tokens first (authority = the seller, who signed).
        // The burn CPI fails cleanly if the seller's ATA is missing or short.
        token_2022::burn(
            CpiContext::new(
                ctx.accounts.token_2022_program.key(),
                token_2022::Burn {
                    from: ctx.accounts.seller_ata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            ),
            token_in,
        )?;

        // Transfer sol_out from the curve_state vault PDA to the seller. The
        // vault is owned by this program, so the payout is a direct lamport
        // move (the system program's Transfer rejects a `from` account that
        // carries data). The checked_sub enforces the vault can cover the
        // payout; a sell that would overdraw the real vault reverts atomically
        // instead of corrupting state.
        let curve_info = ctx.accounts.curve_state.to_account_info();
        let seller_info = ctx.accounts.seller.to_account_info();
        **curve_info.try_borrow_mut_lamports()? = curve_info
            .lamports()
            .checked_sub(sol_out_u64)
            .ok_or(CurveErrorCode::VaultInsufficientFunds)?;
        **seller_info.try_borrow_mut_lamports()? = seller_info
            .lamports()
            .checked_add(sol_out_u64)
            .ok_or(CurveErrorCode::Overflow)?;

        // Boundary: write the pre-converted u64 reserves back.
        let curve_state = &mut ctx.accounts.curve_state;
        curve_state.sol_reserve = sol_reserve_u64;
        curve_state.token_reserve = token_reserve_u64;
        curve_state.supply_out = supply_out_u64;

        Ok(())
    }

    /// Graduates a filled curve. Creator-only: reverts unless the caller is
    /// the recorded `curve_state.creator`. Releases the real SOL (every
    /// vault lamport above the vault's rent-exempt floor) to the creator,
    /// mints the remaining supply to the creator's ATA, revokes the mint
    /// authority, and flags the curve graduated. Idempotent: reverts if
    /// already graduated.
    pub fn graduate(ctx: Context<Graduate>) -> Result<()> {
        // Creator-only: only the recorded creator may finalize the curve. This
        // is the rug-window guard: releasing funds to anyone else would be a
        // rug vector.
        require!(
            ctx.accounts.creator.key() == ctx.accounts.curve_state.creator,
            CurveErrorCode::NotCurveCreator
        );

        let curve_info = ctx.accounts.curve_state.to_account_info();
        let curve_state = &mut ctx.accounts.curve_state;
        graduate_impl(
            curve_state,
            &curve_info,
            &ctx.accounts.mint.to_account_info(),
            &ctx.accounts.creator.to_account_info(),
            &ctx.accounts.creator_ata.to_account_info(),
            &ctx.accounts.mint_authority.to_account_info(),
            ctx.bumps.mint_authority,
            // Payer for on-demand ATA creation: the creator, who signed.
            &ctx.accounts.creator.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.token_2022_program.to_account_info(),
            &ctx.accounts.associated_token_program.to_account_info(),
        )
    }
}

#[derive(Accounts)]
#[instruction(nonce: u64, name: String, symbol: String, uri: String, auto_migrate: bool, lock_lp: bool)]
pub struct Create<'info> {
    /// Creator / payer that funds the mint, the curve_state vault and the
    /// metadata account. Must sign.
    #[account(mut)]
    pub creator: Signer<'info>,
    /// The Token-2022 mint to be created, derived as a PDA from
    /// `["mint", creator, nonce]`. Created via the system create_account CPI
    /// signed with the mint bump, then owned by the token program.
    /// CHECK: address validated by the seeds constraint; created and initialized
    /// in the handler.
    #[account(
        mut,
        seeds = [MINT_SEED, creator.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub mint: UncheckedAccount<'info>,
    /// curve_state PDA, also the SOL vault receiving buy proceeds.
    #[account(
        init,
        payer = creator,
        seeds = [CURVE_SEED, mint.key().as_ref()],
        bump,
        space = 8 + CurveStateAccount::INIT_SPACE,
    )]
    pub curve_state: Account<'info, CurveStateAccount>,
    /// Mint-authority PDA; set as the mint authority so only the program can
    /// mint, and used as the metadata update authority.
    /// CHECK: address validated by the seeds constraint; never deserialized.
    #[account(
        seeds = [MINT_AUTHORITY_SEED, mint.key().as_ref()],
        bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,
    /// Metaplex metadata PDA: `["metadata", mpl_program_id, mint]`, created
    /// and written only by the metadata program CPI.
    /// CHECK: address validated by the seeds constraint; never deserialized.
    #[account(
        mut,
        seeds = [METADATA_SEED, mpl_token_metadata_program.key().as_ref(), mint.key().as_ref()],
        seeds::program = mpl_token_metadata_program.key(),
        bump,
    )]
    pub metadata: UncheckedAccount<'info>,
    /// Instructions sysvar, required by the mpl CreateV1 CPI.
    /// CHECK: address validated by constraint; never deserialized.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub sysvar_instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub token_2022_program: Program<'info, Token2022>,
    pub mpl_token_metadata_program: Program<'info, MplTokenMetadata>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    /// Buyer paying SOL, must be a signer.
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// The Token-2022 mint. Owner checked against the Token-2022 program; the
    /// mint_to CPI enforces it again at runtime.
    /// CHECK: owner validated by constraint; never deserialized here.
    #[account(
        mut,
        constraint = mint.owner == &token_2022_program.key() @ CurveErrorCode::InvalidMintOwner,
    )]
    pub mint: UncheckedAccount<'info>,
    /// curve_state PDA / SOL vault; receives the proceeds.
    #[account(
        mut,
        seeds = [CURVE_SEED, mint.key().as_ref()],
        bump,
    )]
    pub curve_state: Account<'info, CurveStateAccount>,
    /// The buyer's associated token account for the mint. Created via CPI when
    /// missing. Address verified against the standard Token-2022 ATA
    /// derivation (the ATA seeds include the token program id).
    /// CHECK: address verified by constraint; data only read for existence.
    #[account(
        mut,
        constraint = buyer_ata.key() == get_associated_token_address_with_program_id(&buyer.key(), &mint.key(), &token_2022_program.key()) @ CurveErrorCode::InvalidAssociatedTokenAccount,
    )]
    pub buyer_ata: UncheckedAccount<'info>,
    /// The recorded curve creator's wallet. Receives the real SOL when this
    /// buy auto-graduates the curve; address must equal curve_state.creator
    /// (validated in the handler on every buy).
    /// CHECK: address validated in the handler; never deserialized here.
    #[account(mut)]
    pub creator_account: UncheckedAccount<'info>,
    /// The recorded curve creator's ATA for the mint. Receives the remaining
    /// supply when this buy auto-graduates; address must be the creator's real
    /// ATA (validated in the handler on every buy, so a fill buy cannot
    /// redirect the remaining supply).
    /// CHECK: address validated in the handler; never deserialized here.
    #[account(mut)]
    pub creator_ata: UncheckedAccount<'info>,
    /// Mint-authority PDA, used as the signer for the mint_to CPI.
    /// CHECK: address validated by the seeds constraint; never deserialized.
    #[account(
        seeds = [MINT_AUTHORITY_SEED, mint.key().as_ref()],
        bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct Sell<'info> {
    /// Seller selling tokens, must be a signer. Receives sol_out.
    #[account(mut)]
    pub seller: Signer<'info>,
    /// The Token-2022 mint. Owner checked against the Token-2022 program.
    /// CHECK: owner validated by constraint; never deserialized here.
    #[account(
        mut,
        constraint = mint.owner == &token_2022_program.key() @ CurveErrorCode::InvalidMintOwner,
    )]
    pub mint: UncheckedAccount<'info>,
    /// curve_state PDA / SOL vault; pays out sol_out.
    #[account(
        mut,
        seeds = [CURVE_SEED, mint.key().as_ref()],
        bump,
    )]
    pub curve_state: Account<'info, CurveStateAccount>,
    /// The seller's associated token account for the mint; the burn CPI
    /// enforces it exists and holds at least token_in.
    /// CHECK: address verified by constraint; never deserialized here.
    #[account(
        mut,
        constraint = seller_ata.key() == get_associated_token_address_with_program_id(&seller.key(), &mint.key(), &token_2022_program.key()) @ CurveErrorCode::InvalidAssociatedTokenAccount,
    )]
    pub seller_ata: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub token_2022_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct Graduate<'info> {
    /// The recorded curve creator. Must sign; the handler requires the key to
    /// equal `curve_state.creator`. Receives the real SOL and pays for the
    /// on-demand creation of their ATA.
    #[account(mut)]
    pub creator: Signer<'info>,
    /// The Token-2022 mint. Owner checked against the Token-2022 program; the
    /// set_authority CPI enforces it again at runtime.
    /// CHECK: owner validated by constraint; never deserialized here.
    #[account(
        mut,
        constraint = mint.owner == &token_2022_program.key() @ CurveErrorCode::InvalidMintOwner,
    )]
    pub mint: UncheckedAccount<'info>,
    /// curve_state PDA / SOL vault; the real SOL is moved out of here to the
    /// creator, leaving only the vault's own rent-exempt floor.
    #[account(
        mut,
        seeds = [CURVE_SEED, mint.key().as_ref()],
        bump,
    )]
    pub curve_state: Account<'info, CurveStateAccount>,
    /// The creator's associated token account for the mint; receives the
    /// remaining supply. Created via CPI when missing.
    /// CHECK: address verified by constraint; data only read for existence.
    #[account(
        mut,
        constraint = creator_ata.key() == get_associated_token_address_with_program_id(&creator.key(), &mint.key(), &token_2022_program.key()) @ CurveErrorCode::InvalidAssociatedTokenAccount,
    )]
    pub creator_ata: UncheckedAccount<'info>,
    /// Mint-authority PDA, used as the signer for the remaining-supply mint
    /// and for the final mint-authority revoke.
    /// CHECK: address validated by the seeds constraint; never deserialized.
    #[account(
        seeds = [MINT_AUTHORITY_SEED, mint.key().as_ref()],
        bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

/// The mpl-token-metadata program wrapper for Anchor account resolution.
#[derive(Clone)]
pub struct MplTokenMetadata;

impl anchor_lang::Id for MplTokenMetadata {
    fn id() -> Pubkey {
        mpl_token_metadata::ID
    }
}

/// Shared graduation logic used by both trigger modes (the creator-only
/// `graduate` instruction and the auto path inside `buy`).
///
/// 1. Rejects unless the curve is filled and not yet graduated.
/// 2. Computes `real_sol = vault lamports - rent_exempt_minimum`: the vault
///    only ever received the real deposits of each buy (the 30 SOL virtual
///    reserve exists as curve_state state only, never as vault lamports), so
///    releasing everything above the vault's rent floor pays the creator the
///    full raise plus the accrued fees and strands nothing.
/// 3. Mints the remaining supply (`TOTAL_SUPPLY - supply_out`) to the
///    creator's ATA (created on demand, rent paid by `payer`). If the supply
///    is already exhausted the mint is skipped.
/// 4. Revokes the mint authority (set to None) so no future instruction can
///    mint.
/// 5. Moves `real_sol` out of the vault to the creator, the M1 sell pattern.
///    The move is deliberately LAST: a raw lamport mutation followed by a CPI
///    trips the SVM's UnbalancedInstruction delta check, so all CPIs run
///    before any balance changes.
/// 6. Flags the curve graduated.
fn graduate_impl<'a>(
    curve_state: &mut Account<CurveStateAccount>,
    curve_info: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    creator: &AccountInfo<'a>,
    creator_ata: &AccountInfo<'a>,
    mint_authority: &AccountInfo<'a>,
    mint_authority_bump: u8,
    payer: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    token_2022_program: &AccountInfo<'a>,
    associated_token_program: &AccountInfo<'a>,
) -> Result<()> {
    // Idempotent: a graduated curve never graduates again.
    require!(
        !curve_state.graduated,
        CurveErrorCode::AlreadyGraduated
    );
    // The curve must be filled before graduation.
    require!(
        curve_state.sol_reserve >= P::GRADUATION_THRESHOLD_SOL,
        CurveErrorCode::BelowGraduationThreshold
    );

    // 2. Compute the real SOL to release: every vault lamport above the
    //    vault's rent-exempt floor. The vault only ever holds the real
    //    deposits of each buy (create() seeds sol_reserve = 30 SOL as curve
    //    state only; buy() transfers just sol_in of real lamports), so at the
    //    85-SOL threshold it holds roughly 55.56 SOL, never 85 SOL. Releasing
    //    vault - 30 SOL (the pre-M7a code) would strand ~30 SOL of real buyer
    //    deposits in the PDA forever; releasing vault - rent floor pays the
    //    creator the full raise plus the accrued fees and leaves the account
    //    rent-exempt. The actual transfer is deferred to the END of this
    //    function: a direct lamport move followed by a CPI trips the SVM's
    //    UnbalancedInstruction delta check (the check fires when a CPI is
    //    pushed after the account balances changed via a raw mutation), so
    //    the moves happen last, after every CPI, exactly like the M1 sell.
    let rent = Rent::get()?;
    let rent_exempt_minimum = rent.minimum_balance(curve_info.data_len());
    let real_sol = curve_info
        .lamports()
        .checked_sub(rent_exempt_minimum)
        .ok_or(CurveErrorCode::VaultInsufficientFunds)?;

    // 3. Mint the remaining supply to the creator. If supply_out already
    //    equals TOTAL_SUPPLY the remainder is 0 and nothing is minted.
    let remaining_tokens = (P::TOTAL_SUPPLY as u128)
        .checked_sub(curve_state.supply_out as u128)
        .ok_or(CurveErrorCode::SupplyExhausted)?;
    if remaining_tokens > 0 {
        let remaining_u64: u64 =
            u64::try_from(remaining_tokens).map_err(|_| CurveErrorCode::AmountOverflow)?;
        // Create the creator's ATA on demand (missing account is the only
        // case); the payer covers the rent. The idempotent create recovers a
        // pre-funded data-less system account parked at the derived ATA
        // address (an ATA grief) instead of reverting, so a creator whose ATA
        // was griefed can still graduate.
        if creator_ata.data_is_empty() {
            associated_token::create_idempotent(CpiContext::new(
                associated_token_program.key(),
                associated_token::Create {
                    payer: payer.clone(),
                    associated_token: creator_ata.clone(),
                    authority: creator.clone(),
                    mint: mint.clone(),
                    system_program: system_program.clone(),
                    token_program: token_2022_program.clone(),
                },
            ))?;
        }
        // Mint the remainder; the mint-authority PDA signs via its bump.
        token_2022::mint_to(
            CpiContext::new_with_signer(
                token_2022_program.key(),
                token_2022::MintTo {
                    mint: mint.clone(),
                    to: creator_ata.clone(),
                    authority: mint_authority.clone(),
                },
                &[&[
                    MINT_AUTHORITY_SEED,
                    mint.key().as_ref(),
                    &[mint_authority_bump],
                ]],
            ),
            remaining_u64,
        )?;
    }

    // 4. Revoke the mint authority (set to None) so no future instruction can
    //    mint. The mint-authority PDA signs the revoke, then is burned.
    token_2022::set_authority(
        CpiContext::new_with_signer(
            token_2022_program.key(),
            token_2022::SetAuthority {
                current_authority: mint_authority.clone(),
                account_or_mint: mint.clone(),
            },
            &[&[
                MINT_AUTHORITY_SEED,
                mint.key().as_ref(),
                &[mint_authority_bump],
            ]],
        ),
        spl_token_2022::instruction::AuthorityType::MintTokens,
        None,
    )?;

    // 5. Release the real SOL to the creator (deferred until after every CPI,
    //    see step 2). The checked_sub enforces the vault holds at least its
    //    rent floor. After the move the vault keeps exactly its rent-exempt
    //    minimum, so no account is left below rent-exempt and no real buyer
    //    deposit is stranded.
    **curve_info.try_borrow_mut_lamports()? = curve_info
        .lamports()
        .checked_sub(real_sol)
        .ok_or(CurveErrorCode::VaultInsufficientFunds)?;
    **creator.try_borrow_mut_lamports()? = creator
        .lamports()
        .checked_add(real_sol)
        .ok_or(CurveErrorCode::Overflow)?;

    // 6. Flag the curve graduated.
    curve_state.graduated = true;
    Ok(())
}

/// On-chain curve state. Fields are u64 because SPL amounts are u64; the
/// `curve_math::CurveState` (u128) is used only transiently inside buy/sell.
#[account]
#[derive(Default, InitSpace)]
pub struct CurveStateAccount {
    /// The token creator, set at create() to the create signer. Only this
    /// address may call the manual graduate instruction; it also receives the
    /// released SOL and remaining supply on graduation.
    pub creator: Pubkey,
    /// True once the curve has graduated. Buy and sell revert after this;
    /// graduation itself is idempotent.
    pub graduated: bool,
    /// Per-token migration option (dashboard choice at launch): when true, the
    /// buy that fills the curve graduates it in the same instruction; when
    /// false, the creator calls the graduate instruction manually.
    pub auto_migrate: bool,
    /// Per-token migration option (dashboard choice at launch): when true, the
    /// client migration script burns the PumpSwap LP after seeding the pool;
    /// when false, the LP stays under the creator.
    pub lock_lp: bool,
    /// Virtual plus real SOL reserve, lamports.
    pub sol_reserve: u64,
    /// Virtual token reserve, raw units.
    pub token_reserve: u64,
    /// Cumulative tokens minted (monotonic; a sell does not decrease it).
    pub supply_out: u64,
    /// Protocol fee in basis points (100 = 1%).
    pub fee_bps: u64,
    /// Locked total supply cap, raw units (mirror of params::TOTAL_SUPPLY).
    pub total_supply: u64,
    /// Locked graduation threshold, lamports (mirror of
    /// params::GRADUATION_THRESHOLD_SOL).
    pub graduation_threshold_sol: u64,
    /// Locked mint decimals (mirror of params::DECIMALS).
    pub decimals: u8,
}

#[error_code]
pub enum CurveErrorCode {
    #[msg("trade amount is zero")]
    ZeroAmount,
    #[msg("insufficient liquidity for trade")]
    InsufficientLiquidity,
    #[msg("trade overflows u128 arithmetic")]
    Overflow,
    #[msg("curve result does not fit in u64")]
    AmountOverflow,
    #[msg("total supply is exhausted, no more tokens can be minted")]
    SupplyExhausted,
    #[msg("vault does not hold enough lamports to cover the payout")]
    VaultInsufficientFunds,
    #[msg("associated token account address mismatch")]
    InvalidAssociatedTokenAccount,
    #[msg("mint is not owned by the Token-2022 program")]
    InvalidMintOwner,
    #[msg("token name exceeds the maximum length")]
    NameTooLong,
    #[msg("token symbol exceeds the maximum length")]
    SymbolTooLong,
    #[msg("metadata uri exceeds the maximum length")]
    UriTooLong,
    #[msg("metaplex metadata CPI failed")]
    MetadataCpiFailed,
    #[msg("the curve has already graduated")]
    AlreadyGraduated,
    #[msg("the curve is not yet filled to the graduation threshold")]
    BelowGraduationThreshold,
    #[msg("only the recorded curve creator may call this instruction")]
    NotCurveCreator,
}

impl From<CurveError> for anchor_lang::error::Error {
    fn from(e: CurveError) -> Self {
        match e {
            CurveError::ZeroAmount => CurveErrorCode::ZeroAmount.into(),
            CurveError::InsufficientLiquidity => CurveErrorCode::InsufficientLiquidity.into(),
            CurveError::Overflow => CurveErrorCode::Overflow.into(),
        }
    }
}
