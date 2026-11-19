const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..'); const jobs = JSON.parse(fs.readFileSync(path.join(__dirname, 'jobs.json')));
const only = process.argv[2];
(async () => { const b = await chromium.launch();
  const sizes = [[412, 915, 2, true], [1440, 900, 1, true], [360, 800, 1, false], [1024, 768, 1, false], [1280, 800, 1, false]];
  for (const [w, h, dsf, save] of sizes) for (const theme of save ? ['light', 'night'] : ['light']) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf, colorScheme: theme === 'night' ? 'dark' : 'light' });
    const p = await ctx.newPage();
    for (const j of jobs) { if (only && !j.name.startsWith(only)) continue;
      await p.goto('file://' + path.join(root, 'mockups', j.lang, j.name + '.html')); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(60);
      const ov = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      if (ov > 0) console.log('H-OVERFLOW', w, j.lang, j.name, ov);
      if (!save) continue;
      const d = path.join(root, 'mockups/png', `${w}x${h}`, theme, j.lang); fs.mkdirSync(d, { recursive: true });
      await p.screenshot({ path: path.join(d, j.name + '.png') }); }
    await ctx.close(); }
  await b.close(); })();
