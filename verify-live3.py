#!/usr/bin/env python3
"""Live TubePlus v2 verification via Obscura CDP + Playwright (works in this
sandbox): 360px overflow, drawer open + computed opacity evidence,
category click in drawer, like toggle, sort by likes."""
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
        page = browser.new_page(viewport={'width': 360, 'height': 800})
        page.goto('https://tubeplus.www5.workers.dev/')
        page.wait_for_timeout(4000)
        out['overflow360'] = page.evaluate("""() => ({
            innerWidth: window.innerWidth,
            docSW: document.documentElement.scrollWidth,
            bodySW: document.body.scrollWidth,
            headerSW: document.querySelector('header').scrollWidth
        })""")
        page.click('#menuBtn')
        page.wait_for_timeout(1000)
        out['drawer'] = page.evaluate("""() => {
            var d = document.getElementById('drawer');
            var cs = getComputedStyle(d);
            var el = document.elementFromPoint(100, 200);
            return {
                open: d.classList.contains('open'),
                cats: document.querySelectorAll('#drawer [data-cat]').length,
                channels: document.querySelectorAll('#drawer .ch').length,
                tv: !!document.getElementById('tvBtn'),
                theme: !!document.getElementById('themeBtn'),
                about: !!document.getElementById('aboutBtn'),
                headerHasTv: !!document.querySelector('header #tvBtn'),
                headerHasTheme: !!document.querySelector('header #themeBtn'),
                headerHasAbout: !!document.querySelector('header #aboutBtn'),
                bg: cs.backgroundColor, opacity: cs.opacity,
                zIndex: cs.zIndex, position: cs.position,
                elAtPoint: el ? (el.id || el.className || el.tagName) : null,
                elInDrawer: el ? !!el.closest('#drawer') : null
            };
        }""")
        page.screenshot(path='/tmp/tp-360-drawer-obscura.png')
        page.click('#drawer [data-cat="space"]')
        page.wait_for_timeout(2500)
        out['drawer_cat_click'] = page.evaluate("""() => ({
            rescount: (document.getElementById('rescount')||{}).textContent,
            drawerOpen: document.getElementById('drawer').classList.contains('open'),
            cards: document.querySelectorAll('.card').length
        })""")
        page.goto('https://tubeplus.www5.workers.dev/')
        page.wait_for_timeout(3000)
        out['like_video'] = page.evaluate("() => document.querySelector('.like-btn').getAttribute('data-like')")
        page.click('.like-btn')
        page.wait_for_timeout(1500)
        out['like_after_click'] = page.evaluate("""() => {
            var b = document.querySelector('.like-btn');
            return {liked: b.classList.contains('liked'), count: b.querySelector('.lc').textContent,
                    ls: localStorage.getItem('liked'), hash: location.hash};
        }""")
        page.click('.like-btn')
        page.wait_for_timeout(1500)
        out['like_after_unlike'] = page.evaluate("""() => {
            var b = document.querySelector('.like-btn');
            return {liked: b.classList.contains('liked'), count: b.querySelector('.lc').textContent};
        }""")
        page.select_option('#sortsel', 'likes')
        page.wait_for_timeout(2000)
        out['sort_likes'] = page.evaluate("""() => ({
            rescount: (document.getElementById('rescount')||{}).textContent,
            firstCardLikes: (document.querySelector('.like-btn .lc')||{}).textContent
        })""")
        browser.close()
    print(json.dumps(out, indent=2))
finally:
    serve.terminate()
