#!/usr/bin/env python3
"""Live TubePlus verification via Obscura CDP + Playwright."""
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
        page = browser.new_page(viewport={'width': 1280, 'height': 900})
        # 1. Watch page
        page.goto('https://tubeplus.www5.workers.dev/#/watch/GuCdsyCWmt8')
        page.wait_for_timeout(5000)
        out['watch'] = page.evaluate("""() => ({
            title: (document.querySelector('.watch h1')||{}).textContent,
            player: !!document.querySelector('#ytplayer'),
            upnext: document.querySelectorAll('.mini').length,
            tags: document.querySelectorAll('.watchtags .tag').length,
            docTitle: document.title
        })""")
        # 2. Home page + boot state
        page.goto('https://tubeplus.www5.workers.dev/')
        page.wait_for_timeout(4000)
        out['home'] = page.evaluate("""() => ({
            total: state.total, nextPage: state.nextPage,
            cards: document.querySelectorAll('.card').length,
            sentinel: !!document.getElementById('sentinel'),
            rescount: (document.getElementById('rescount')||{}).textContent
        })""")
        # 3. Category filter click (space)
        page.click('[data-cat="space"]')
        page.wait_for_timeout(2500)
        out['space_filter'] = page.evaluate("""() => ({
            rescount: (document.getElementById('rescount')||{}).textContent,
            cards: document.querySelectorAll('.card').length,
            firstCardSub: (document.querySelector('.card .sub')||{}).textContent
        })""")
        # 4. Tag filter click (first tag pill)
        page.click('[data-cat=""]')
        page.wait_for_timeout(2000)
        page.click('.tag')
        page.wait_for_timeout(2500)
        out['tag_filter'] = page.evaluate("""() => ({
            activeTag: (document.querySelector('.activetag')||{}).textContent,
            rescount: (document.getElementById('rescount')||{}).textContent,
            cards: document.querySelectorAll('.card').length
        })""")
        page.screenshot(path='/tmp/tp-home-live.png')
        browser.close()
    print(json.dumps(out, indent=2))
finally:
    serve.terminate()
