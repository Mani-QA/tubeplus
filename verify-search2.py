#!/usr/bin/env python3
"""Diagnose the search-submit path on the local dev server (:8787).
1. Is there a JS error on load? 2. Does fill() actually set #q's value?
3. Does a manually dispatched submit event fire the handler (hash changes)?"""
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
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.type + ': ' + m.text) if m.type == 'error' else None)
        page.goto('http://localhost:8787/')
        page.wait_for_timeout(3000)
        out['pageErrors'] = errors
        page.fill('#q', 'rocket')
        out['qValueAfterFill'] = page.evaluate("() => document.getElementById('q').value")
        out['formExists'] = page.evaluate("() => !!document.getElementById('searchForm')")
        # Manually dispatch a submit event — this MUST invoke the handler if attached.
        page.evaluate("""() => {
            var f = document.getElementById('searchForm');
            f.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
        }""")
        page.wait_for_timeout(2500)
        out['afterDispatchSubmit'] = page.evaluate("""() => ({
            hash: location.hash,
            rescount: (document.getElementById('rescount')||{}).textContent,
            cards: document.querySelectorAll('.card').length
        })""")
        # Also: does requestSubmit exist as a function at all in this engine?
        out['requestSubmitType'] = page.evaluate("() => typeof document.getElementById('searchForm').requestSubmit")
        browser.close()
    print(json.dumps(out, indent=2))
finally:
    serve.terminate()
