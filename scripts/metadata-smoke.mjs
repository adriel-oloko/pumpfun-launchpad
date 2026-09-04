// Milestone M9: LIVE vps-leg rehearsal (local, zero credentials).
//
// Proves the preferred mainnet metadata backend end to end on this machine:
//   1. compiles the engine (npx tsc -p tsconfig.build.json -> .build)
//   2. spawns the dependency-free VPS receiver (tools/metadata-vps/server.mjs)
//      on 127.0.0.1 with a throwaway secret + temp root
//   3. runs the real engine (lib/metadata-publish.ts) against it with a
//      tiny fake PNG + full structured fields
//   4. GETs the returned uri + imageUrl and asserts content byte-for-byte
//
// The Pinata/ipfs leg is NOT rehearsed live (this repo holds no JWT); it is
// proven by the mock-fetch unit tests (tests/pumpfun-metadata.ts), which
// verify the request shapes against the real Pinata dialect.
//
// Run: node scripts/metadata-smoke.mjs   (expect all PASS + exit 0)

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
process.chdir(ROOT)

console.log('== metadata smoke: compiling engine (.build) ==')
execSync('npx tsc -p tsconfig.build.json', { stdio: 'inherit' })

const { publishTokenMetadataBundle } = await import(
  path.join(ROOT, '.build/lib/metadata-publish.js')
)

const PORT = 20000 + Math.floor(Math.random() * 20000)
const SECRET = 'smoke-secret-123'
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'pumpfun-meta-'))
const BASE = `http://127.0.0.1:${PORT}`

console.log(`== metadata smoke: spawning receiver on :${PORT} ==`)
const receiver = spawn(
  process.execPath,
  [path.join(ROOT, 'tools/metadata-vps/server.mjs')],
  {
    cwd: DATA_DIR,
    env: {
      ...process.env,
      METADATA_SECRET: SECRET,
      METADATA_PORT: String(PORT),
      METADATA_ROOT: DATA_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
)
receiver.stdout.on('data', (d) => process.stdout.write(`  [receiver] ${d}`))
receiver.stderr.on('data', (d) => process.stderr.write(`  [receiver-err] ${d}`))

async function waitHealthy(msBudget) {
  const deadline = Date.now() + msBudget
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`)
      if (r.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('receiver did not become healthy in time')
}

let failed = 0
function check(label, cond, extra) {
  if (cond) {
    console.log(`  PASS ${label}`)
  } else {
    failed += 1
    console.error(`  FAIL ${label}${extra ? ` -- ${extra}` : ''}`)
  }
}

const IMAGE_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
])

try {
  await waitHealthy(10_000)
  check('receiver health', true)

  console.log('== metadata smoke: publishing bundle through the engine ==')
  const result = await publishTokenMetadataBundle({
    fields: {
      name: 'Smoke Coin',
      symbol: 'SMOKE',
      description: 'Smoke test token metadata',
      website: 'example.com',
      twitter: '@smokecoin',
      telegram: 'smokegroup',
    },
    image: {
      filename: 'smoke-coin.png',
      contentType: 'image/png',
      bytes: IMAGE_BYTES,
    },
    config: {
      id: 'vps',
      vps: {
        uploadUrl: `${BASE}/put`,
        baseUrl: BASE,
        secret: SECRET,
      },
    },
  })

  console.log(`  uri       = ${result.uri}`)
  console.log(`  imageUrl  = ${result.imageUrl}`)
  check('uri is under the http base', result.uri.startsWith(`${BASE}/`))
  check('uri ends with metadata.json', result.uri.endsWith('/metadata.json'))
  check('imageUrl ends with smoke-coin.png', result.imageUrl.endsWith('/smoke-coin.png'))
  check('uri byte length <= 200', Buffer.byteLength(result.uri, 'utf8') <= 200)

  const metaRes = await fetch(result.uri)
  check('metadata.json serves HTTP 200', metaRes.status === 200)
  const meta = await metaRes.json()
  check('json name matches', meta.name === 'Smoke Coin')
  check('json symbol matches', meta.symbol === 'SMOKE')
  check('json description matches', meta.description === 'Smoke test token metadata')
  check('json website normalized to https', meta.website === 'https://example.com')
  check('json external_url mirrors website', meta.external_url === 'https://example.com')
  check('json twitter normalized', meta.twitter === 'https://x.com/smokecoin')
  check('json telegram normalized', meta.telegram === 'https://t.me/smokegroup')
  check('json image points at the served image URL', meta.image === result.imageUrl)

  const imgRes = await fetch(result.imageUrl)
  check('image serves HTTP 200', imgRes.status === 200)
  check('image content-type is png', (imgRes.headers.get('content-type') ?? '').includes('image/png'))
  const got = new Uint8Array(await imgRes.arrayBuffer())
  check(
    'image bytes round-trip exactly',
    got.length === IMAGE_BYTES.length &&
      got.every((b, i) => b === IMAGE_BYTES[i])
  )

  // Bad-secret PUT must be refused (receiver auth).
  const bad = await fetch(`${BASE}/put?path=probe.json`, {
    method: 'PUT',
    headers: { 'x-metadata-secret': 'wrong', 'content-type': 'application/json' },
    body: '{}',
  })
  check('receiver rejects a wrong secret with 401', bad.status === 401)

  console.log(failed === 0 ? '== metadata smoke: ALL PASS ==' : `== metadata smoke: ${failed} FAILED ==`)
} finally {
  receiver.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 300))
}

process.exit(failed === 0 ? 0 : 1)
