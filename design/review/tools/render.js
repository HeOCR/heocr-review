const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..'); const jobs = JSON.parse(fs.readFileSync(path.join(__dirname, 'jobs.json')));
(async () => { const b = await chromium.launch();
  for (const theme of ['light', 'night']) for (const j of jobs) {
    const sizes = j.w > 500 ? [[1440, 900], [1280, 800], [1024, 768]] : [[412, 915], [360, 800]];
    for (const [w, h] of sizes) {
      const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w > 500 ? 1 : 2, colorScheme: theme === 'night' ? 'dark' : 'light' });
      const p = await ctx.newPage(); await p.goto('file://' + path.join(root, 'mockups', j.lang, j.name + '.html')); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(120);
      const ov = await p.evaluate(() => [document.documentElement.scrollWidth - innerWidth, document.documentElement.scrollHeight - innerHeight]);
      if (ov[0] > 0 || ov[1] > 0) console.log('overflow', w, theme, j.lang, j.name, ov);
      const d = path.join(root, 'mockups/png', `${w}x${h}`, theme, j.lang); fs.mkdirSync(d, { recursive: true });
      await p.screenshot({ path: path.join(d, j.name + '.png') }); await ctx.close(); } }
  await b.close(); })();
