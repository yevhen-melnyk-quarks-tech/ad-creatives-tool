# Visual Review Loop

Automated browser screenshot + Claude vision analysis. Runs from `/execute` after
local implementation, before asking the user to confirm the build.

No auth to fixture — this is an internal tool with no login. That removes the
biggest source of complexity in the growli-spa version of this command; the whole
thing is just: pick the affected page(s), screenshot, look, fix, repeat.

**Dev server must already be running on `http://localhost:3000`** (or pass the
actual port if a different one is in use).

---

## Step 1 — Identify Target Pages

From the plan and the change just made, list the pages plausibly affected:

- `/` — the project list/create page
- `/projects/[id]` — the workspace (almost every feature change lands here; use a
  real project id that already has the relevant state — a scene with multiple
  takes, a failed job, whatever the change touches)

Don't screenshot pages the change didn't touch.

## Step 2 — Install Playwright (if needed)

```bash
npx playwright --version 2>/dev/null || echo "not installed"
```

If not installed: `npm install --save-dev @playwright/test && npx playwright install chromium`.
Do this silently, don't ask.

## Step 3 — Screenshot Loop

For each target page, iterate up to **3 times**:

### 3a — Write the screenshot script

Write fresh to `/tmp/vr-screenshot.mjs` before each run:

```javascript
import { chromium } from '@playwright/test';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

const URL = process.env.VR_URL;
const OUT_MOBILE = process.env.VR_OUT_MOBILE;
const OUT_DESKTOP = process.env.VR_OUT_DESKTOP;

const browser = await chromium.launch();

async function shoot(viewport, output, colorScheme) {
  const ctx = await browser.newContext({ viewport, colorScheme });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500); // let the 4s poll refresh settle at least once
  mkdirSync(dirname(output), { recursive: true });
  await page.screenshot({ path: output, fullPage: true });
  await ctx.close();
  console.log(`Saved: ${output}`);
}

await shoot({ width: 390, height: 844 }, 'light', OUT_MOBILE);
await shoot({ width: 1280, height: 800 }, 'light', OUT_DESKTOP);
await browser.close();
```

Include a `dark` colour-scheme pass too when the change touches anything
theme-related (the light/dark token system in `app/globals.css`) — otherwise light
alone is enough.

### 3b — Run it

```bash
VR_URL="http://localhost:3000/projects/<id>" \
VR_OUT_MOBILE="test-results/visual-review/<slug>-mobile-iter<N>.png" \
VR_OUT_DESKTOP="test-results/visual-review/<slug>-desktop-iter<N>.png" \
node /tmp/vr-screenshot.mjs
```

### 3c — Analyze with vision

Read both PNGs with the Read tool. Check:
- Text overflow or clipped content
- Broken flex/grid layout
- Elements missing or wrong vs what the plan expected
- Inconsistent spacing/misalignment
- Interactive elements looking broken (buttons cut off, icons missing)
- Horizontal scroll at 390px (must never occur)
- Contrast — this project rebuilt its whole colour system once already over an
  unreadable-text incident (see `PROJECT.md`/git history); a light-on-light or
  dark-on-dark pair anywhere is a real regression, not a nitpick
- The specific thing this change was supposed to show (a new button, a tightened
  spacing, a new banner) actually visible and correct — not just "nothing looks
  broken"

### 3d — Decision

- **CLEAN** → mark PASSED, move to next page.
- **ISSUES FOUND** → fix, wait 2s for hot reload, increment iteration, go back to 3b.
- **Iteration 3 reached, still failing** → mark FAILED with the final screenshot
  paths. Do not attempt a 4th fix.

## Step 4 — Report

```
Visual Review Report

PASSED   /projects/<id>   — clean (mobile + desktop, iter 1)
PASSED   /                — fixed: button overlap at 390px (iter 2)
FAILED   /projects/<id>   — mobile: takes list clips at 390px, unresolved after 3 iterations
                             → test-results/visual-review/workspace-mobile-iter3.png
```

If any FAILED: show the failing screenshots inline and describe the issue. Do not
proceed to the deploy confirmation — ask the user how to proceed with the failing
screen(s) first.

If all PASSED: hand off to the local-build confirmation in `/execute`.

## Behaviour Rules

- Only screenshot pages plausibly affected — never the whole app.
- Max 3 iterations per screen.
- Always rewrite `/tmp/vr-screenshot.mjs` fresh.
- `test-results/` should be gitignored — screenshots are local only, never committed.
