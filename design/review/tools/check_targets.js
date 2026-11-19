const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '../mockups');
(async () => { const b = await chromium.launch(); let n = 0, bad = {};
  for (const [w, h] of [[412, 915], [360, 800]]) { const page = await (await b.newContext({ viewport: { width: w, height: h } })).newPage();
    for (const lang of ['he', 'en']) for (const f of fs.readdirSync(path.join(root, lang))) {
      await page.goto('file://' + path.join(root, lang, f));
      const r = await page.evaluate(() => [...document.querySelectorAll('button, a[href], summary, input, select, textarea, label.check')].filter(e => e.getClientRects().length).map(e => { const r = e.getBoundingClientRect(); return { c: (e.className || e.tagName) + '', w: Math.round(r.width), h: Math.round(r.height), l: !!(e.getAttribute('aria-label') || e.textContent.trim() || e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') }; }));
      for (const x of r) { n++; if (x.w < 44 || x.h < 44) bad[`${x.c} ${x.w}x${x.h}`] = (bad[`${x.c} ${x.w}x${x.h}`] || 0) + 1; if (!x.l) console.log('UNLABELLED', f, x.c); } } }
  console.log('controls', n); console.log(bad); await b.close(); })();
