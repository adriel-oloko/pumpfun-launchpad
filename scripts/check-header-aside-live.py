#!/usr/bin/env python3
"""Live acceptance for the Trade header's Token Address aside.

Loads the local dev server, types a real mainnet pump.fun mint into the Token
Address field, and reads back the aside text (it must be "Name ($TICKER)") plus
the on-chain metadata the panel resolved. Read-only: no wallet is imported and
nothing is signed or sent.
"""
import sys

from playwright.sync_api import sync_playwright

CHROME = "/home/adriel/.agent-browser/browsers/chrome-151.0.7922.71/chrome"
URL = "http://localhost:3001"
MINT = sys.argv[1] if len(sys.argv) > 1 else "EXgpvQiForS3zzon7grz58Mn24Jiu2fdCT31KXvVpump"

READ_ASIDE = """
() => {
  const spans = [...document.querySelectorAll('span')];
  const label = spans.find(
    (s) => s.textContent.trim() === 'Token Address' && s.className.includes('label-mono')
  );
  if (!label) return { error: 'Token Address field not found' };
  const row = label.parentElement;
  const rowSpans = [...row.querySelectorAll('span')];
  const aside = rowSpans.length > 1 ? rowSpans[rowSpans.length - 1] : null;
  if (!aside) return { error: 'aside not rendered' };
  return { label: label.textContent.trim(), aside: aside.textContent, title: aside.title };
}
"""

READ_SOCIALS = """
() => {
  const rows = [...document.querySelectorAll('div.reveal-up')];
  for (const row of rows) {
    const links = [...row.querySelectorAll('a')];
    if (links.length) return links.map((a) => a.textContent.trim() + ' -> ' + a.href);
  }
  return [];
}
"""

def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, headless=True)
        page = browser.new_page()
        errors: list[str] = []
        page.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.goto(URL, wait_until="domcontentloaded", timeout=180_000)
        field = page.locator('input[placeholder="BASE58... (MINT)"]')
        field.wait_for(timeout=120_000)
        print(f"field present, typing mint {MINT}")
        field.fill(MINT)
        # the header reads the mint over RPC, then fetches the off-chain JSON
        page.wait_for_timeout(12_000)
        print("aside      :", page.evaluate(READ_ASIDE))
        print("socials    :", page.evaluate(READ_SOCIALS))
        print("console err:", errors[-5:] or "none")
        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
