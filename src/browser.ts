import { connect } from 'puppeteer-real-browser';
import type { Browser } from 'rebrowser-puppeteer-core';
import type { PageWithCursor } from 'puppeteer-real-browser';
import * as path from 'path';
import * as fs from 'fs';
import { TopGGCookie, AppConfig } from './types';

export interface BrowserSession {
  browser: Browser;
  page: PageWithCursor;
}

/**
 * Resolves the Chrome or Chromium executable binary path
 */
function resolveChromeExecutable(config: AppConfig): string | undefined {
  const configuredPath =
    config.chromePath ||
    process.env.BROWSER_PATH ||
    process.env.CHROME_PATH ||
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROMIUM_PATH;

  if (configuredPath && fs.existsSync(configuredPath)) {
    return configuredPath;
  }

  if (process.platform === 'linux') {
    const candidatePaths = [
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/home/container/chrome-linux/chrome',
      '/home/container/chrome/chrome',
      '/home/container/chromium/chrome',
      '/home/container/.cache/puppeteer/chrome',
      '/usr/lib/chromium/chromium',
      '/snap/bin/chromium',
    ];
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        if (configuredPath) {
          console.warn(
            `  ⚠️ [Browser] Configured path "${configuredPath}" not found on disk. Falling back to detected binary: ${p}`
          );
        }
        return p;
      }
    }
  }

  if (configuredPath) {
    console.warn(
      `  ⚠️ [Browser] Configured browser path "${configuredPath}" does not exist on disk!`
    );
  }

  return undefined;
}

/**
 * Ensures minimal Linux container environments have a dummy 'ps' command
 * so tree-kill doesn't throw ENOENT on browser shutdown
 */
function ensurePsBinaryShim(): void {
  if (process.platform !== 'linux') return;
  try {
    const { execSync } = require('child_process');
    execSync('which ps', { stdio: 'ignore' });
  } catch {
    try {
      const shimDir = path.resolve(process.cwd(), '.bin');
      const shimPath = path.join(shimDir, 'ps');
      if (!fs.existsSync(shimDir)) {
        fs.mkdirSync(shimDir, { recursive: true });
      }
      if (!fs.existsSync(shimPath)) {
        fs.writeFileSync(shimPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      }
      if (!process.env.PATH?.includes(shimDir)) {
        process.env.PATH = `${shimDir}:${process.env.PATH || ''}`;
      }
    } catch {}
  }
}

/**
 * Resolves Chrome executable path from config/environment/system,
 * or automatically downloads Chrome if no installation is found on the system.
 */
async function ensureChromeAvailable(config: AppConfig): Promise<string | undefined> {
  const existing = resolveChromeExecutable(config);
  if (existing) {
    return existing;
  }

  const cacheDir = path.resolve(process.cwd(), '.cache', 'browsers');
  try {
    const { getInstalledBrowsers, Browser } = await import('@puppeteer/browsers');
    const installed = await getInstalledBrowsers({ cacheDir });
    const chrome = installed.find((b: any) => b.browser === Browser.CHROME && fs.existsSync(b.executablePath));
    if (chrome) {
      console.log(`  [Browser] Using cached Chrome binary: ${chrome.executablePath}`);
      return chrome.executablePath;
    }
  } catch {}

  console.log('\n  ⬇️ [Browser] No Chrome installation found on system.');
  console.log('  ⬇️ [Browser] Automatically downloading Chrome for this environment (one-time setup)...');
  try {
    const { install, Browser, detectBrowserPlatform, resolveBuildId } = await import('@puppeteer/browsers');
    const platform = detectBrowserPlatform();
    if (!platform) {
      throw new Error(`Unsupported platform: ${process.platform} ${process.arch}`);
    }

    const buildId = await resolveBuildId(Browser.CHROME, platform, 'stable');
    console.log(`  ⬇️ [Browser] Downloading Chrome stable (${buildId}) into .cache/browsers...`);

    const result = await install({
      browser: Browser.CHROME,
      buildId,
      cacheDir,
      platform,
    });

    console.log(`  ✅ [Browser] Chrome successfully installed to: ${result.executablePath}\n`);
    return result.executablePath;
  } catch (err: any) {
    console.error(`  ❌ [Browser] Automated Chrome download failed: ${err.message}`);
    return undefined;
  }
}

/**
 * Initializes and launches a stealth browser session with Cloudflare Turnstile bypass
 */
export async function createBrowserSession(config: AppConfig): Promise<BrowserSession> {
  ensurePsBinaryShim();
  const isWindows = process.platform === 'win32';
  const isLinux = process.platform === 'linux';

  const defaultUserAgent = isLinux
    ? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

  const userAgent = process.env.USER_AGENT || defaultUserAgent;

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=1280,800',
    `--user-agent=${userAgent}`,
  ];

  const chromeExecutable = await ensureChromeAvailable(config);
  if (chromeExecutable) {
    process.env.CHROME_PATH = chromeExecutable;
    process.env.BROWSER_PATH = chromeExecutable;
    process.env.PUPPETEER_EXECUTABLE_PATH = chromeExecutable;
    console.log(`  [Browser] Using Chrome executable: ${chromeExecutable}`);
  } else if (isLinux) {
    console.warn(
      '\n⚠️ [Browser] No Chrome/Chromium executable found!' +
      '\n   Please set BROWSER_PATH or CHROME_PATH in your .env file' +
      '\n   (e.g. BROWSER_PATH=/home/container/chrome-linux/chrome or CHROME_PATH=/usr/bin/chromium)\n'
    );
  }

  const disableXvfb =
    process.env.DISABLE_XVFB === '1' ||
    process.env.DISABLE_XVFB === 'true' ||
    (isLinux && config.headless);

  const headlessMode = config.headless ? 'new' : false;

  const { browser, page } = await connect({
    headless: headlessMode as any,
    args,
    turnstile: true,
    disableXvfb,
    ...(chromeExecutable ? { customConfig: { chromePath: chromeExecutable } } : {}),
  });

  await page.setUserAgent(userAgent);
  await page.setViewport({ width: 1280, height: 800 });

  return { browser, page };
}

/**
 * Injects Top.gg cookies into the browser context
 */
export async function injectCookies(page: PageWithCursor, cookies: TopGGCookie[]): Promise<void> {
  if (!cookies || cookies.length === 0) return;

  for (const c of cookies) {
    const item: any = {
      name: c.name,
      value: c.value,
      path: c.path || '/',
      httpOnly: Boolean(c.httpOnly),
      secure:
        c.name.startsWith('__Secure-') || c.name.startsWith('__Host-')
          ? true
          : Boolean(c.secure),
    };

    if (c.name.startsWith('__Host-')) {
      item.url = 'https://top.gg';
    } else {
      item.domain = c.domain?.startsWith('.') ? c.domain : `.${c.domain || 'top.gg'}`;
    }

    if (c.expires && typeof c.expires === 'number') {
      item.expires = c.expires;
    }
    if (c.sameSite) {
      item.sameSite = c.sameSite;
    }

    try {
      await page.setCookie(item);
    } catch (err: any) {
      console.warn(`  ⚠️ Cookie warning (${c.name}): ${err.message}`);
    }
  }
}

/**
 * Dismisses GDPR / Cookie consent popups if present
 */
export async function dismissPrivacyOverlay(page: PageWithCursor): Promise<boolean> {
  try {
    const dismissed = await page.evaluate(() => {
      const body = document.body ? document.body.innerText.toLowerCase() : '';
      const looksLikeConsent =
        body.includes('we value your privacy') ||
        body.includes('partners store and/or access information') ||
        body.includes('personalised ads and content');

      if (!looksLikeConsent) return false;

      const direct = document.querySelector('#accept-btn') as HTMLElement | null;
      if (direct) {
        direct.click();
        return true;
      }

      const labels = new Set(['agree', 'accept', 'accept all', 'allow all', 'i agree']);
      const buttons = Array.from(
        document.querySelectorAll('button, [role="button"], input[type="button"]')
      ) as HTMLElement[];

      const target = buttons.find((el) => {
        const text = [el.innerText, el.textContent, el.getAttribute('aria-label'), el.id]
          .filter(Boolean)
          .join(' ')
          .trim()
          .toLowerCase();
        return labels.has(text) || text.includes('agree') || text.includes('accept');
      });

      if (target) {
        target.click();
        return true;
      }

      return false;
    });

    return Boolean(dismissed);
  } catch {
    return false;
  }
}

/**
 * Checks if user is authenticated on Top.gg
 */
export async function checkTopGGAuth(page: PageWithCursor): Promise<boolean> {
  try {
    const authResult = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/auth/session', { credentials: 'include' });
        if (res.ok) {
          const session: any = await res.json();
          if (session && session.user) return true;
        }
      } catch {}
      try {
        const body = document.body ? document.body.innerText.toLowerCase() : '';
        if (body && !body.includes('verify you are human') && !body.includes('just a moment')) {
          const buttons = Array.from(document.querySelectorAll('a, button'));
          const hasLogin = buttons.some((el) => {
            const t = ((el as HTMLElement).innerText || '').trim().toLowerCase();
            return t === 'login' || t === 'log in';
          });

          if (
            !hasLogin &&
            (body.includes('voting for') ||
              body.includes('you will be able to vote') ||
              body.includes('vote again in') ||
              body.includes('already voted'))
          ) {
            return true;
          }
        }
      } catch {}

      return false;
    });

    return Boolean(authResult);
  } catch {
    return false;
  }
}

/**
 * Captures screenshot and saves to screenshots directory
 */
export async function captureScreenshot(
  page: PageWithCursor,
  fileNamePrefix: string
): Promise<string | undefined> {
  try {
    const dir = path.resolve(process.cwd(), 'screenshots');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const timestamp = Date.now();
    const cleanPrefix = fileNamePrefix.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(dir, `${cleanPrefix}_${timestamp}.png`);

    await page.screenshot({ path: filePath, fullPage: false });
    return filePath;
  } catch (err: any) {
    console.error(`[Browser] Failed to capture screenshot: ${err.message}`);
    return undefined;
  }
}

/**
 * Safely closes browser session
 */
export async function closeBrowserSession(session?: BrowserSession): Promise<void> {
  if (!session) return;
  try {
    if (session.page && !session.page.isClosed()) {
      await session.page.close().catch(() => {});
    }
  } catch {}

  try {
    if (session.browser) {
      await session.browser.close().catch(() => {});
    }
  } catch {}
}
