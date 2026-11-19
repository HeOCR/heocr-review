# How the files in `design/review/` were produced

Reference scripts; nothing in the app needs them. They need Python 3 and Node with Playwright (Chromium).

```
python make_review.py     # mockups/*.html, icons/*.svg, strings.json
node render.js            # mockups/png/** (412x915 at 2x and 1440x900, light and night); reports sideways overflow at 360, 1024, 1280
node check_targets.js     # measures every control at 412 and 360 wide: size and label
```

The PNGs in the package were then saved with a 256-colour palette to keep the folder small. All text is invented. Nothing reads from the network.
