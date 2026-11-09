#!/usr/bin/env python3
"""Check the search-submit path against the local dev server (:8787).
Tests three ways to trigger search: requestSubmit() (real form submit),
direct #/search/ navigation, and page.press Enter (the method the SEO
subagent's browser check used, which failed — diagnostic only)."""
import subprocess, time, json

OBSCURA = '/home/hatch/.local/bin/obscura'
serve = subprocess.Popen([OBSCURA, '--allow-private-network', 'serve', '--port', '9222'],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(4)
try:
    from playwright.sync_api import sync_playwright
    out = {}
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp('http://127.0.0.1:9222')
        page = browser.new_page(viewport={'width': 1280, 'height': 800})
        page.goto('http://localhost:8787/')
        page.wait_for_timeout(3000)
        # 1. real form submission via requestSubmit
        page.fill('#q', 'rocket')
        page.evaluate("() => document.getElementById('searchForm').requestSubmit()")
        page.wait_for_timeout(2500)
        out['requestSubmit'] = page.evaluate("""() => ({
            hash: location.hash,
            rescount: (document.getElementById('rescount')||{}).textContent,
            cards: document.querySelectorAll('.card').length
        })""")
        # 2. direct hash navigation
        page.goto('http://localhost:8787/#/search/rocket')
        page.wait_for_timeout(2500)
        out['hashNav'] = page.evaluate("""() => ({
            hash: location.hash,
            rescount: (document.getElementById('rescount')||{}).textContent,
            cards: document.querySelectorAll('.card').length
        })""")
        # 3. page.press Enter (subagent's method) — diagnostic
        page.goto('http://localhost:8787/')
        page.wait_for_timeout(2500)
        page.fill('#q', 'rocket')
        page.press('#q', 'Enter')
        page.wait_for_timeout(2500)
        out['pressEnter'] = page.evaluate("""() => ({
            hash: location.hash,
            rescount: (document.getElementById('rescount')||{}).textContent,
            cards: document.querySelectorAll('.card').length
        })""")
        browser.close()
    print(json.dumps(out, indent=2))
finally:
    serve.terminate()
