#!/usr/bin/env python3
"""Smoke test: run the portable dial solver against the local mirror.

Acceptance is a real PASS from the mirror's own /submit endpoint, not a code
review.  Start the mirror first:

    python3 /media/data/fun-noSync/tools/security/captcha/mirror/server.py \
        --port 8788 --ttl 1800
    python3 smoke.py

It prints the computed angle, the mirror's ground-truth error (via /grade,
which does not consume the puzzle), and the solver's submitted verdict.
Exit code 0 only on PASS.
"""
import json
import os
import sys
import urllib.request

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
SOLVER = os.path.join(HERE, 'dial-solver.js')
BASE = os.environ.get('DIAL_MIRROR', 'http://127.0.0.1:8788')


def get(path):
    return json.load(urllib.request.urlopen(BASE + path, timeout=5))


def main():
    if not os.path.exists(SOLVER):
        print('missing solver:', SOLVER)
        return 2
    try:
        get('/last')
    except Exception as e:                        # noqa: BLE001
        print('mirror not reachable at %s (%s)' % (BASE, e))
        print('start it with: python3 .../mirror/server.py --port 8788 --ttl 1800')
        return 2

    js = open(SOLVER).read()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1000, 'height': 900})
        page.goto(BASE + '/', wait_until='load', timeout=30000)
        page.evaluate(js)
        page.locator('#notRobotWrapper').click()
        page.wait_for_selector('#source[src^="data:"]', timeout=15000)
        page.wait_for_timeout(1200)               # load animation

        computed = page.evaluate("() => SquireDial.compute('mirror')")
        h = page.locator('#captchaHash').input_value()
        graded = get('/grade?captchaHash=%s&userRotateDegrees=%d'
                     % (urllib.parse.quote(h), round(computed['angle'])))
        print('computed  :', json.dumps({
            'angle': computed['angle'], 'corr': round(computed['corr'], 4),
            'confidence': round(computed['confidence'], 4),
            'bands': computed['bands']}, sort_keys=True))
        print('mirror    :', json.dumps(graded, sort_keys=True))

        result = page.evaluate("() => SquireDial.solve('mirror')")
        shown = page.locator('#open_contact_ajax').inner_text().strip()
        print('solve     :', json.dumps({
            'status': result['status'], 'angle': result['angle'],
            'corr': round(result['corr'], 4), 'rounds': result['rounds'],
            'attempts': result['attempts']}, sort_keys=True, default=str))
        print('page text :', shown)

        ok = result.get('status') == 'pass' and bool(shown)
        print('SMOKE: %s' % ('PASS' if ok else 'FAIL'))
        browser.close()
        return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
