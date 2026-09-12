import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'

/**
 * Playwright runs against the LOCAL Supabase stack (supabase/LOCAL-DEV.md),
 * never the shared remote project. `.env.local` already points there; the
 * webServer below inherits it.
 *
 * Port 3100, not 3000: this machine frequently has another dev server on 3000,
 * and Next silently falls back to 3001, which would make `baseURL` wrong and
 * every test fail on a redirect to nowhere. Pinning a port nothing else uses is
 * cheaper than debugging that twice.
 *
 * 127.0.0.1 rather than localhost: on Windows, Node may resolve `localhost` to
 * ::1 while Next binds 0.0.0.0, producing intermittent ECONNREFUSED during
 * startup probing.
 */

const PORT = 3100
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './tests',
  /**
   * Serial, single worker, and that is deliberate.
   *
   * Every spec runs against ONE local Postgres, and several of them write to
   * it — creating what-if scenarios, editing phases. Run in parallel, a
   * scenario created by the sandbox spec appears in the Timeline spec's
   * "Resume…" control while its screenshot is being taken, and the resulting
   * diff looks exactly like a rendering regression. It is not; it is a fixture
   * leak between workers.
   *
   * The alternative is a database per worker, which is real work for a suite
   * this size. Serial costs about 30 seconds.
   */
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: 60_000,
  reporter: [['html', { open: 'never' }], ['list']],

  /**
   * `{platform}` is retained. Windows renders text through DirectWrite with
   * Segoe UI; a Linux CI container renders through FreeType with Liberation
   * Sans. Sharing one baseline set between them means either permanent
   * whole-page text diffs, or a `threshold` loosened far enough to absorb them
   * — at which point the suite stops detecting real regressions. Separate
   * baselines per platform is the honest arrangement.
   */
  snapshotPathTemplate:
    '{testDir}/__screens__/{projectName}/{testFileBaseName}/{arg}-{platform}{ext}',

  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      // Leave `threshold` at its 0.2 default (per-pixel YIQ tolerance) and
      // constrain the budget instead — that catches a small solid regression
      // which a raised threshold would wave through.
      maxDiffPixelRatio: 0.002,
      stylePath: path.join(__dirname, 'tests/helpers/screenshot.css'),
    },
  },

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',

    // Determinism. Every one of these removes a source of pixel drift that is
    // nothing to do with the code under test.
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    colorScheme: 'light',
    forcedColors: 'none',
    timezoneId: 'UTC',
    locale: 'en-US',
  },

  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'app',
      testDir: './tests/app',
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/admin.json',
      },
    },
    {
      name: 'public',
      testDir: './tests/public',
      use: { ...devices['Desktop Chrome'], storageState: { cookies: [], origins: [] } },
    },
  ],

  webServer: {
    // Production build, never `next dev`. The dev overlay (<nextjs-portal>)
    // paints into screenshots, HMR keeps a socket open so `networkidle` never
    // settles, and dev compiles routes lazily so the first navigation to each
    // page is seconds slower than the rest — all three are pixel and timing
    // noise that has nothing to do with the app.
    command: `npm run build && npx next start --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
