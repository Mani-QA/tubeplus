#!/usr/bin/env python3
"""Live TubePlus v2 verification in REAL Chromium (not Obscura):
360px overflow, drawer open + opacity, category click in drawer,
like toggle, sort by likes."""
import json
import os
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

# This sandbox routes traffic through an egress proxy; Chromium launched by
# Playwright does not pick it up on its own. Pass host/port plus the
# credentials separately (the token in the URL can trip Chromium's parsing).
_proxy_url = os.environ.get('https_proxy') or os.environ.get('HTTPS_PROXY')
_launch_kw = {'args': ['--no-sandbox']}
if _proxy_url:
    _u = urlparse(_proxy_url)
    _launch_kw['proxy'] = {
        'server': f"{_u.scheme}://{_u.hostname}:{_u.port}",
        'username': _u.username,
        'password': _u.password,
    }

out = {}
with sync_playwright() as p:
    browser = p.chromium.launch(**_launch_kw)
    page = browser.new_page(viewport={'width': 360, 'height': 800})
    page.goto('https://tubeplus.www5.workers.dev/')
    page.wait_for_timeout(4000)
    out['overflow360'] = page.evaluate("""() => ({
        innerWidth: window.innerWidth,
        docSW: document.documentElement.scrollWidth,
        bodySW: document.body.scrollWidth,
        headerSW: document.querySelector('header').scrollWidth
    })""")
    # drawer open
    page.click('#menuBtn')
    page.wait_for_timeout(1000)
    out['drawer'] = page.evaluate("""() => ({
        open: document.getElementById('drawer').classList.contains('open'),
        cats: document.querySelectorAll('#drawer [data-cat]').length,
        channels: document.querySelectorAll('#drawer .ch').length,
        tv: !!document.getElementById('tvBtn'),
        theme: !!document.getElementById('themeBtn'),
        about: !!document.getElementById('aboutBtn'),
        headerHasTv: !!document.querySelector('header #tvBtn'),
        headerHasTheme: !!document.querySelector('header #themeBtn'),
        bg: getComputedStyle(document.getElementById('drawer')).backgroundColor,
        opacity: getComputedStyle(document.getElementById('drawer')).opacity
    })""")
    page.screenshot(path='/tmp/tp-360-drawer-real.png')
    # category click inside drawer (space)
    page.click('#drawer [data-cat="space"]')
    page.wait_for_timeout(2500)
    out['drawer_cat_click'] = page.evaluate("""() => ({
        rescount: (document.getElementById('rescount')||{}).textContent,
        drawerOpen: document.getElementById('drawer').classList.contains('open'),
        cards: document.querySelectorAll('.card').length
    })""")
    # like toggle on first card (home)
    page.goto('https://tubeplus.www5.workers.dev/')
    page.wait_for_timeout(3000)
    first_id = page.evaluate("() => document.querySelector('.like-btn').getAttribute('data-like')")
    out['like_video'] = first_id
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
    # sort by likes via the dropdown
    page.select_option('#sortsel', 'likes')
    page.wait_for_timeout(2000)
    out['sort_likes'] = page.evaluate("""() => ({
        rescount: (document.getElementById('rescount')||{}).textContent,
        firstCardLikes: (document.querySelector('.like-btn .lc')||{}).textContent
    })""")
    page.screenshot(path='/tmp/tp-360-home-real.png')
    browser.close()
print(json.dumps(out, indent=2))
