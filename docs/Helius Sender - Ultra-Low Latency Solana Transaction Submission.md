> ## Documentation Index
>
> Fetch the complete documentation index at:
> https://www.helius.dev/docs/llms.txt Use this file to discover all available
> pages before exploring further.

# Helius Sender: Ultra-Low Latency Solana Transaction Submission

> Ultra-low latency Solana transaction submission with multi-path routing. No
> credits consumed, global endpoints, optimized for high-frequency trading.

## Overview

<Note>
  **Pricing update:** Sender Max now uses a **0.001 SOL** minimum tip. This
  enters you into a priority tip buffer for top of block — tip more to land first. The cost-optimized
  [SWQOS-only](/docs/sending-transactions/sender-swqos-only) tier remains at 0.000005
  SOL.
</Note>

Helius Sender is a specialized service for ultra-low latency transaction
submission, built for latency-sensitive trading. It submits your transaction
across all pathways (Helius, Jito, Harmonic, Rakurai, etc.) simultaneously to
give it the fastest possible route into a block.

Sender **does not consume API credits** — you pay per transaction with a SOL
tip. It is available on every plan, including the free tier.

<CardGroup cols={2}>
  <Card title="No Credits" icon="coins">
    Available on all plans without consuming API credits. You pay per send with
    a SOL tip.
  </Card>

  <Card title="Multi-Path Routing" icon="arrows-split-up-and-left">
    Submits across all pathways (Helius, Jito, Harmonic, Rakurai, etc.) for the fastest possible inclusion
  </Card>

  <Card title="Global Endpoints" icon="globe">
    HTTPS endpoint auto-routes to the nearest location for frontends, regional
    HTTP for backends
  </Card>

  <Card title="50 TPS (Default)" icon="gauge-high" href="https://www.helius.dev/contact">
    Need more? Request higher limits and custom tip arrangements
  </Card>
</CardGroup>

## Choose your tier

Sender offers two tiers. Both are low-latency and credit-free — the difference
is how many pathways your transaction takes and the minimum tip required.

| Tier                                                       | Routing                 | Minimum tip  | Tip buffer | Best for                                                              |
| ---------------------------------------------------------- | ----------------------- | ------------ | ---------- | --------------------------------------------------------------------- |
| [Sender Max](/docs/sending-transactions/sender-max)        | All high-speed pathways | 0.001 SOL    | Yes        | Highly contested transactions and bundles needing the fastest landing |
| [SWQOS-only](/docs/sending-transactions/sender-swqos-only) | Single SWQOS path       | 0.000005 SOL | No         | Cost-optimized trading on one fast path                               |

<Note>
  Tips between 0.000005 SOL and 0.001 SOL are accepted but do **not** enter the
  priority tip buffer — they are sent on a best-effort basis through fewer
  pathways. To get buffer priority and every routing pathway, tip at least 0.001
  SOL.
</Note>

<CardGroup cols={2}>
  <Card title="Sender Max (fastest landing)" icon="trophy" href="/docs/sending-transactions/sender-max">
    Routed across every pathway and entered into a priority tip buffer for the
    most competitive submissions. Handles both transactions and bundles.
  </Card>

  <Card title="SWQOS-only (cost-optimized)" icon="dollar-sign" href="/docs/sending-transactions/sender-swqos-only">
    Lowest tip, single fast path. Add `?swqos_only=true` to any endpoint URL.
  </Card>
</CardGroup>

## Quickstart Guide

Ready to submit your first ultra-low latency Solana transaction? This guide gets
you started in minutes. The best part: **you don't need any paid plan or special
access** — Sender is available to all users and doesn't consume API credits.

The example below uses the [Sender Max](/docs/sending-transactions/sender-max)
tier (0.001 SOL tip). For the lowest-tip option, see
[SWQOS-only](/docs/sending-transactions/sender-swqos-only).

<Steps titleSize="h3">
  <Step title="Create Your Free Helius Account">
    Start by creating your free account at the [Helius Dashboard](https://dashboard.helius.dev/dashboard). Sender is available on all plans, including the free tier, and doesn't consume any API credits.
  </Step>

  <Step title="Get Your API Key">
    Go to the [API Keys](https://dashboard.helius.dev/api-keys) section and copy your key. Use this for getting blockhashes and transaction confirmation. Sender will handle transaction submission.
  </Step>

  <Step title="Send Your First Transaction">
    Let's send a simple SOL transfer using Sender. This example includes the required tip and priority fee, and skips preflight for lower latency (optional).

    <Tabs>
      <Tab title="@solana/web3.js">
        ```typescript [expandable] theme={"system"}
        import {
          Connection,
          TransactionMessage,
          VersionedTransaction,
          SystemProgram,
          PublicKey,
          Keypair,
          LAMPORTS_PER_SOL,
          ComputeBudgetProgram
        } from '@solana/web3.js';
        import bs58 from 'bs58';

        const TIP_ACCOUNTS = [
          "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
          "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
          "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta"
          // ... more tip accounts available
        ];

        async function sendWithSender(
          keypair: Keypair,
          recipientAddress: string
        ): Promise<string> {
          const connection = new Connection(
            'https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY'
          );

          const { value: { blockhash } } = await connection.getLatestBlockhashAndContext('confirmed');

          // Build transaction with tip transfer and transfer to recipient
          const transaction = new VersionedTransaction(
            new TransactionMessage({
              instructions: [
                ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
                SystemProgram.transfer({
                  fromPubkey: keypair.publicKey,
                  toPubkey: new PublicKey(recipientAddress),
                  lamports: 1 * LAMPORTS_PER_SOL,
                }),
                SystemProgram.transfer({
                  fromPubkey: keypair.publicKey,
                  toPubkey: new PublicKey(TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)]),
                  lamports: 0.001 * LAMPORTS_PER_SOL,
                })
              ],
              payerKey: keypair.publicKey,
              recentBlockhash: blockhash,
            }).compileToV0Message()
          );

          transaction.sign([keypair]);
          console.log('Sending transaction via Sender endpoint...');

          const response = await fetch('https://sender.helius-rpc.com/fast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: Date.now().toString(),
              method: 'sendTransaction',
              params: [
                Buffer.from(transaction.serialize()).toString('base64'),
                {
                  encoding: 'base64',
                  skipPreflight: true, // Optional: skip for lower latency
                  maxRetries: 0
                }
              ]
            })
          });

          const json = await response.json();
          if (json.error) {
            throw new Error(json.error.message);
          }

          console.log('Transaction sent:', json.result);
          return json.result;
        }

        // Usage
        const keypair = Keypair.fromSecretKey(bs58.decode('YOUR_PRIVATE_KEY'));
        sendWithSender(keypair, 'RECIPIENT_ADDRESS');
        ```
      </Tab>

      <Tab title="@solana/kit">
        ```typescript [expandable] theme={"system"}
        import { pipe } from "@solana/kit";
        import {
          createSolanaRpc,
          createTransactionMessage,
          setTransactionMessageFeePayerSigner,
          setTransactionMessageLifetimeUsingBlockhash,
          appendTransactionMessageInstruction,
          signTransactionMessageWithSigners,
          lamports,
          getBase64EncodedWireTransaction,
          createKeyPairSignerFromBytes,
          address,
        } from "@solana/kit";
        import { getTransferSolInstruction } from "@solana-program/system";
        import {
          getSetComputeUnitLimitInstruction,
          getSetComputeUnitPriceInstruction,
        } from "@solana-program/compute-budget";
        import bs58 from 'bs58';

        const TIP_ACCOUNTS = [
          "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
          "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
          "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta"
          // ... more tip accounts available
        ];

        async function sendWithSender(
          privateKeyB58: string,
          recipientAddress: string
        ): Promise<string> {
          // Load signer from base58 private key
          const ownerSigner = await createKeyPairSignerFromBytes(bs58.decode(privateKeyB58));

          // Init RPC and fetch blockhash
          const rpc = createSolanaRpc('https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY');
          const { value: blockhash } = await rpc.getLatestBlockhash().send();

          // Build + sign transaction
          const tx = pipe(
            createTransactionMessage({ version: 0 }),
            (m) => setTransactionMessageFeePayerSigner(ownerSigner, m),
            (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
            (m) => appendTransactionMessageInstruction(getSetComputeUnitLimitInstruction({ units: 100_000 }), m),
            (m) => appendTransactionMessageInstruction(getSetComputeUnitPriceInstruction({ microLamports: 200_000 }), m),
            (m) =>
              appendTransactionMessageInstruction(
                getTransferSolInstruction({
                  source: ownerSigner,
                  destination: address(recipientAddress),
                  amount: lamports(1_000_000_000n), // 1 SOL
                }),
                m
              ),
            (m) =>
              appendTransactionMessageInstruction(
                getTransferSolInstruction({
                  source: ownerSigner,
                  destination: address(TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)]),
                  amount: lamports(1_000_000n), // 0.001 SOL
                }),
                m
              )
          );

          const signedTx = await signTransactionMessageWithSigners(tx);
          const base64Tx = getBase64EncodedWireTransaction(signedTx);

          console.log('Sending transaction via Sender endpoint...');

          // Send via Sender
          const res = await fetch("https://sender.helius-rpc.com/fast", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: Date.now().toString(),
              method: "sendTransaction",
              params: [
                base64Tx,
                { encoding: "base64", skipPreflight: true, maxRetries: 0 },
              ],
            }),
          });

          const { result: sig, error } = await res.json();
          if (error) throw new Error(error.message);

          console.log("Transaction sent: ", sig);
          return sig;
        }

        // Usage
        sendWithSender('YOUR_PRIVATE_KEY', 'RECIPIENT_ADDRESS');
        ```
      </Tab>
    </Tabs>

  </Step>

  <Step title="Success! Understanding What Happened">
    You've successfully submitted a transaction via Sender! Here's what made it work:

    * No credits consumed: Sender is credit-free for all users
    * Multi-path routing: Your transaction was submitted across all pathways (Helius, Jito, Harmonic, Rakurai, etc.) simultaneously
    * Required tip: A 0.001 SOL tip enters the priority tip buffer and uses every routing pathway. See [tiers](#choose-your-tier) for the lower-tip SWQOS-only option
    * Priority fee: Signals validators your willingness to pay for priority processing
    * Skipped preflight (optional): Trades validation for speed — Sender also supports preflight checks

  </Step>
</Steps>

## Requirements

<Warning>
  **Mandatory requirements**: Every Sender transaction must include a tip
  (minimum 0.001 SOL for [Sender Max](/docs/sending-transactions/sender-max), or
  0.000005 SOL for [SWQOS-only](/docs/sending-transactions/sender-swqos-only)) and a
  priority fee.
</Warning>

<Note>
  `skipPreflight` is optional — Sender supports preflight checks. Set
  `skipPreflight: true` to trade validation for lower latency.
</Note>

### Tips and priority fees

All transactions submitted through Sender **must include both a tip and a
priority fee**:

- **Tip**: A SOL transfer to a designated tip account. Minimum 0.001 SOL for
  Sender Max, or 0.000005 SOL for SWQOS-only.
- **Priority fee**: Compute unit pricing via
  `ComputeBudgetProgram.setComputeUnitPrice` to prioritize your transaction in
  the validator queue.

<Accordion title="Designated Tip Accounts (mainnet-beta)">
  ```text theme={"system"}
  4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE
  D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ
  9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta
  5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn
  2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD
  2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ
  wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF
  3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT
  4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey
  4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or
  ```
</Accordion>

#### Why both are required

- **Tips**: Give you access to all of Sender's routing pathways (Helius, Jito,
  Harmonic, Rakurai, etc.) and the priority tip buffer
- **Priority fees**: Signal to validators your willingness to pay for priority
  processing through Solana's native prioritization system
- **Together**: Tips maximize the pathways your transaction can take, while
  priority fees improve its priority with validators — together they maximize
  inclusion probability

Use the [Helius Priority Fee API](/docs/priority-fee-api) for real-time priority
fee recommendations.

## Endpoints

Sender endpoints are available in multiple configurations depending on your use
case:

<Tabs>
  <Tab title="Frontend/Browser Applications">
    **Recommended for frontend applications to avoid CORS issues:**

    ```
    https://sender.helius-rpc.com/fast   # Global HTTPS endpoint
    ```

    <Note>
      The HTTPS endpoint resolves CORS preflight failures that occur with
      browser-based applications when using the regional HTTP endpoints. This
      endpoint automatically routes to the nearest location for optimal
      performance. Use this for frontend/browser use cases.
    </Note>

  </Tab>

  <Tab title="Backend/Server Applications">
    **Regional HTTP endpoints for optimal server-to-server latency:**

    ```
    http://slc-sender.helius-rpc.com/fast   # Salt Lake City
    http://ewr-sender.helius-rpc.com/fast   # Newark
    http://lon-sender.helius-rpc.com/fast   # London
    http://fra-sender.helius-rpc.com/fast   # Frankfurt
    http://ams-sender.helius-rpc.com/fast   # Amsterdam
    http://sg-sender.helius-rpc.com/fast    # Singapore
    http://tyo-sender.helius-rpc.com/fast   # Tokyo
    ```

    <Note>
      For backend/server applications, choose the regional HTTP endpoint closest
      to your infrastructure for optimal performance.
    </Note>

  </Tab>

  <Tab title="Connection Warming">
    **HTTPS (Frontend):**

    ```
    https://sender.helius-rpc.com/ping   # Global HTTPS ping (auto-routes to nearest location)
    ```

    **HTTP (Backend):**

    ```
    http://slc-sender.helius-rpc.com/ping   # Salt Lake City
    http://ewr-sender.helius-rpc.com/ping   # Newark
    http://lon-sender.helius-rpc.com/ping   # London
    http://fra-sender.helius-rpc.com/ping   # Frankfurt
    http://ams-sender.helius-rpc.com/ping   # Amsterdam
    http://sg-sender.helius-rpc.com/ping    # Singapore
    http://tyo-sender.helius-rpc.com/ping   # Tokyo
    ```

  </Tab>
</Tabs>

## Connection Warming

For applications with long periods between transaction submissions, use the ping
endpoint to maintain warm connections and reduce cold start latency.

The ping endpoint accepts simple GET requests and returns a basic response to
keep connections alive:

```bash theme={"system"}
# Frontend applications - use HTTPS (auto-routes to nearest location)
curl https://sender.helius-rpc.com/ping

# Backend applications - use regional HTTP
curl http://slc-sender.helius-rpc.com/ping
```

```typescript theme={"system"}
// Keep connection warm during idle periods
async function warmConnection(endpoint: string) {
    try {
        const response = await fetch(`${endpoint}/ping`)
        console.log('Connection warmed:', response.ok)
    } catch (error) {
        console.warn('Failed to warm connection:', error)
    }
}

// Frontend applications - use HTTPS endpoint
setInterval(() => {
    warmConnection('https://sender.helius-rpc.com')
}, 5000)

// Backend/server applications - use regional HTTP endpoint
setInterval(() => {
    warmConnection('http://slc-sender.helius-rpc.com')
}, 5000)
```

<Note>
  Use connection warming when your application has gaps longer than 5 seconds
  between transactions to maintain optimal submission latency.
</Note>

## Request Format

Sender accepts two methods on the same endpoint. Every submission must include
both a tip and a priority fee; skipping preflight is optional (it lowers
latency).

### sendTransaction

Submit a single transaction. It must contain both a SOL transfer with the
minimum tip to a designated tip account **and** a compute unit price instruction
— without both, it will be rejected.

```typescript theme={"system"}
{
  "id": "unique-request-id",
  "jsonrpc": "2.0",
  "method": "sendTransaction",
  "params": [
    "BASE64_ENCODED_TRANSACTION", // Must include both tip and priority fee instructions
    {
      "encoding": "base64",
      "skipPreflight": true,       // Optional: skip for lower latency
      "maxRetries": 0
    }
  ]
}
```

See the [Quickstart](#quickstart-guide) for a complete, runnable
`sendTransaction` example.

### sendBundle

Submit up to 4 fully-signed transactions for atomic, all-or-nothing execution.
At least one transaction must carry the tip.

```typescript theme={"system"}
{
  "id": "unique-request-id",
  "jsonrpc": "2.0",
  "method": "sendBundle",
  "params": [
    ["BASE64_SIGNED_TX_1", "BASE64_SIGNED_TX_2"], // Up to 4; at least one carries the tip
    { "encoding": "base64" }
  ]
}
```

See [Sender Max bundles](/docs/sending-transactions/sender-max#bundles) for a
full example and how to track landing.

### MEV Protect (optional)

To route around validators statistically linked to sandwich attacks, add the
`mev-protect=true` query parameter to the endpoint URL. It works on both Sender
tiers and on both `sendTransaction` and `sendBundle`, with no changes to your
request body.

```
https://sender.helius-rpc.com/fast?mev-protect=true                    # Sender Max
https://sender.helius-rpc.com/fast?swqos_only=true&mev-protect=true     # SWQOS-only
```

See [MEV Protect](/docs/sending-transactions/mev-protect) for how it works and
its tradeoffs.

<Card title="API Reference" icon="code" href="/docs/api-reference/sender/sendtransaction">
  View the complete Sender API reference with request/response schemas and
  parameters.
</Card>

## Rate Limits and Scaling

- **Default Rate Limit**: 50 transactions per second
- **No Credit Usage**: Sender transactions don't consume API credits from your
  plan
- **Higher Limits**: Professional plan users can request significant rate limit
  increases to support high-throughput trading applications

### Custom TPS with API Key Authentication

<Note>
  This section is only relevant if you have been granted increased TPS limits
  and received an API key from the Helius team. Standard users can skip this
  section.
</Note>

If you have been approved for higher TPS limits, you will receive a dedicated
API key for Sender. To use it, append the API key as a query parameter to your
endpoint URL:

<Tabs>
  <Tab title="Frontend/Browser Applications">
    ```
    https://sender.helius-rpc.com/fast?api-key=YOUR_SENDER_API_KEY
    ```
  </Tab>

  <Tab title="Backend/Server Applications">
    ```
    http://slc-sender.helius-rpc.com/fast?api-key=YOUR_SENDER_API_KEY
    http://ewr-sender.helius-rpc.com/fast?api-key=YOUR_SENDER_API_KEY
    http://lon-sender.helius-rpc.com/fast?api-key=YOUR_SENDER_API_KEY
    http://fra-sender.helius-rpc.com/fast?api-key=YOUR_SENDER_API_KEY
    http://ams-sender.helius-rpc.com/fast?api-key=YOUR_SENDER_API_KEY
    http://sg-sender.helius-rpc.com/fast?api-key=YOUR_SENDER_API_KEY
    http://tyo-sender.helius-rpc.com/fast?api-key=YOUR_SENDER_API_KEY
    ```
  </Tab>
</Tabs>

<Tip>
  Need more than 50 TPS or a custom plan? [Request higher
  limits](https://www.helius.dev/contact) and explore custom tip arrangements
  for Sender by contacting our sales team.
</Tip>

## Support

Get support through the [Helius Dashboard](https://dashboard.helius.dev) or join
[Discord](https://discord.com/invite/6GXdee3gBj) for assistance.

## See Also: Shred Delivery

[Raw Shreds (UDP)](/docs/shred-delivery/raw-shreds) is our specialized delivery
of raw Solana shreds via UDP, built to give you ultra low-latency access to
Solana's raw transaction data.

By delivering unprocessed shreds directly from the network, Shred Delivery
provides a competitive edge for propAMMs, snipers, copy traders, liquidation
bots, arbitrage, and RPC node operators who want to remove network sync latency.

<Tip>
  Start receiving raw shreds. [Subscribe to Helius Shred
  Delivery](https://dashboard.helius.dev/shred-delivery-seats) in your dashboard.
</Tip>
