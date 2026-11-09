#!/usr/bin/env python3
"""TubePlus SEO browser checks (g)-(i) against a local wrangler dev server,
via Obscura CDP + Playwright (the sandbox's working browser path).
Usage: python3 verify-seo-browser.py [base_url]  (default http://127.0.0.1:8787)"""
import json, subprocess, sys, time

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8787'
OBSCURA = '/home/hatch/.local/bin/obscura'
fails = []

def check(name, ok, detail=''):
    print(('PASS' if ok else 'FAIL'), '-', name, ('| ' + detail if detail else ''))
    if not ok:
        fails.append(name)

serve = subprocess.Popen([OBSCURA, '--allow-private-network', 'serve', '--port', '9223'],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(4)
try:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp('http://127.0.0.1:9223')
        page = browser.new_page(viewport={'width': 1280, 'height': 800})

        # (g) click a card -> path URL, no reload, watch renders, like toggles, back -> home
        page.goto(BASE + '/')
        page.wait_for_timeout(4000)
        page.evaluate("window.__norefresh = 1")
        first_href = page.get_attribute('.card >> nth=0', 'href')
        page.click('.card >> nth=0')
        page.wait_for_timeout(3000)
        url = page.url
        check('(g) card click -> /watch/<id>/<slug> URL', url.startswith(BASE + '/watch/') and len(url.split('/')) >= 6, url)
        check('(g) no full page reload on card click', page.evaluate("window.__norefresh") == 1)
        check('(g) watch renders: h1 + player + up-next',
              bool(page.query_selector('h1')) and bool(page.query_selector('#ytplayer'))
              and page.locator('#upnext .mini').count() >= 1,
              f"h1={page.text_content('h1')[:60] if page.query_selector('h1') else None} minis={page.locator('#upnext .mini').count()}")
        like = page.locator('.watch .like-btn')
        check('(g) watch like button present', like.count() == 1)
        like.click()
        page.wait_for_timeout(1200)
        lc = page.text_content('.watch .like-btn .lc')
        ls = page.evaluate("localStorage.getItem('liked')")
        check('(g) like toggles 0 -> 1 + localStorage', lc == '1' and 'IvUU8joBb1Q' in (ls or ''), f'lc={lc} ls={ls}')
        like.click()
        page.wait_for_timeout(1200)
        check('(g) unlike back to 0', page.text_content('.watch .like-btn .lc') == '0')
        page.go_back()
        page.wait_for_timeout(2500)
        check('(g) back button returns to home', page.url in (BASE + '/', BASE + '/#/') or page.url == BASE + '/',
              page.url)
        check('(g) home grid back after back-nav', page.locator('.card').count() > 0,
              f"cards={page.locator('.card').count()}")

        # (h) direct load of a canonical watch path -> SSR adopted, not re-rendered
        page.goto(BASE + '/watch/IvUU8joBb1Q/wintergatan-marble-machine-music-instrument-using-2000')
        page.wait_for_timeout(4000)
        check('(h) direct /watch load renders h1 + player + up-next',
              page.text_content('h1').startswith('Wintergatan - Marble Machine')
              and bool(page.query_selector('#ytplayer')) and page.locator('#upnext .mini').count() >= 1)
        check('(h) SSR adopted: #ssrWatch JSON still in DOM (no client re-render)',
              bool(page.query_selector('#ssrWatch')))
        check('(h) SSR title kept (em-dash, not client hyphen title)',
              '— TubePlus' in page.title(), page.title())
        check('(h) drawer still opens on a path watch page',
              (page.click('#menuBtn'), page.wait_for_timeout(800), page.evaluate("document.getElementById('drawer').classList.contains('open')"))[2])
        page.keyboard.press('Escape')
        page.wait_for_timeout(500)

        # (i) legacy hash watch link converts to the path URL
        page.goto(BASE + '/#/watch/GuCdsyCWmt8')
        page.wait_for_timeout(4000)
        check('(i) #/watch/<id> converts to path URL',
              page.url == BASE + '/watch/GuCdsyCWmt8/electron-microscope-slow-motion-video-of-vinyl-lp', page.url)
        check('(i) watch renders after conversion',
              page.query_selector('h1') and 'Electron microscope' in page.text_content('h1'))

        # regression spot-checks: search + drawer category + sort still work
        page.goto(BASE + '/')
        page.wait_for_timeout(3000)
        page.fill('#q', 'rocket')
        page.press('#q', 'Enter')
        page.wait_for_timeout(2500)
        check('regression: hash search still works', '#/search/rocket' in page.url and page.locator('.card').count() > 0,
              f"url={page.url} cards={page.locator('.card').count()}")
        page.goto(BASE + '/')
        page.wait_for_timeout(3000)
        page.click('#menuBtn')
        page.wait_for_timeout(800)
        page.click('#drawer [data-cat="space"]')
        page.wait_for_timeout(2500)
        check('regression: drawer category filter still works',
              page.text_content('#rescount') == '4,252 videos', page.text_content('#rescount') or '')
        check('regression: Most liked sort option present',
              'Most liked' in (page.text_content('#sortsel') or ''))
        browser.close()
finally:
    serve.terminate()

print()
print('RESULT:', 'ALL PASS' if not fails else f'{len(fails)} FAILURES: {fails}')
sys.exit(1 if fails else 0)
