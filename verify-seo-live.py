#!/usr/bin/env python3
"""Live SEO checks in a browser (Obscura CDP): card click -> pushState to
/watch/<id>/<slug>, direct watch load, legacy #/watch/ conversion, and
search via direct hash navigation."""
import subprocess, time, json

OBSCURA = '/home/hatch/.local/bin/obscura'
serve = subprocess.Popen([OBSCURA, '--allow-private-network', 'serve', '--port', '9225'],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(4)
try:
    from playwright.sync_api import sync_playwright
    out = {}
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp('http://127.0.0.1:9225')
        page = browser.new_page(viewport={'width': 1280, 'height': 800})
        # 1. card click -> pushState, no reload
        page.goto('https://tubeplus.www5.workers.dev/')
        page.wait_for_timeout(4000)
        page.evaluate("() => { window.__norefresh = true; }")
        page.click('.card >> nth=0')
        page.wait_for_timeout(3000)
        out['cardClick'] = page.evaluate("""() => ({
            url: location.href,
            norefresh: window.__norefresh === true,
            h1: (document.querySelector('.watch h1')||{}).textContent,
            upnext: document.querySelectorAll('.mini').length,
            likeBtn: !!document.querySelector('.watch .like-btn')
        })""")
        # 2. direct watch load
        page.goto('https://tubeplus.www5.workers.dev/watch/IvUU8joBb1Q/wintergatan-marble-machine-music-instrument-using-2000')
        page.wait_for_timeout(3500)
        out['directWatch'] = page.evaluate("""() => ({
            url: location.href,
            h1: (document.querySelector('.watch h1')||{}).textContent,
            upnext: document.querySelectorAll('.mini').length,
            title: document.title
        })""")
        # 3. legacy hash -> canonical path
        page.goto('https://tubeplus.www5.workers.dev/#/watch/GuCdsyCWmt8')
        page.wait_for_timeout(3500)
        out['legacyHash'] = page.evaluate("""() => ({
            url: location.href,
            h1: (document.querySelector('.watch h1')||{}).textContent
        })""")
        # 4. search via direct hash (route + viewSearch)
        page.goto('https://tubeplus.www5.workers.dev/#/search/rocket')
        page.wait_for_timeout(3000)
        out['searchHash'] = page.evaluate("""() => ({
            rescount: (document.getElementById('rescount')||{}).textContent,
            cards: document.querySelectorAll('.card').length
        })""")
        browser.close()
    print(json.dumps(out, indent=2))
finally:
    serve.terminate()
