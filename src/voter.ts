import type { PageWithCursor } from 'puppeteer-real-browser';
import { VoteResult, AppConfig } from './types';
import { dismissPrivacyOverlay, checkTopGGAuth, captureScreenshot } from './browser';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Detects whether Cloudflare Managed Challenge or Turnstile is actively blocking the page
 */
export async function isCloudflareActive(page: PageWithCursor): Promise<boolean> {
  try {
    const pageTitle = (await page.title()).toLowerCase();
    if (
      pageTitle.includes('just a moment') ||
      pageTitle.includes('cloudflare') ||
      pageTitle.includes('attention required')
    ) {
      return true;
    }

    return await page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      if (
        text.includes('verifying you are human') ||
        text.includes('verify you are human') ||
        text.includes('security service to protect against malicious bots') ||
        text.includes('checking your browser') ||
        text.includes('please solve the captcha') ||
        (text.includes('ray id:') && text.includes('cloudflare'))
      ) {
        return true;
      }

      const hasCfElements = Boolean(
        document.querySelector('#challenge-stage') ||
        document.querySelector('#challenge-running') ||
        document.querySelector('#challenge-form') ||
        document.querySelector('#cf-wrapper') ||
        document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
        document.querySelector('iframe[src*="turnstile"]') ||
        document.querySelector('#turnstile-wrapper')
      );

      return hasCfElements;
    });
  } catch {
    return false;
  }
}

/**
 * Proactively bypasses / solves Cloudflare Turnstile challenges
 */
export async function resolveCloudflareChallenge(
  page: PageWithCursor,
  maxTimeoutMs: number = 60000
): Promise<boolean> {
  const startTime = Date.now();
  let challengeDetected = false;

  while (Date.now() - startTime < maxTimeoutMs) {
    const active = await isCloudflareActive(page);
    if (!active) {
      if (challengeDetected) {
        console.log('  ✅ Cloudflare challenge successfully passed!');
      }
      return true;
    }

    if (!challengeDetected) {
      console.log('  🛡️ Cloudflare verification detected, attempting automated bypass...');
      challengeDetected = true;
    }

    try {
      for (const frame of page.frames()) {
        const frameUrl = frame.url();
        if (frameUrl.includes('challenges.cloudflare.com') || frameUrl.includes('turnstile')) {
          await frame.evaluate(() => {
            const checkbox = document.querySelector('input[type="checkbox"]') as HTMLElement | null;
            if (checkbox) {
              checkbox.click();
              return true;
            }
            const target = document.querySelector('#challenge-stage, .ctp-checkbox-label, #content, body') as HTMLElement | null;
            if (target) {
              target.click();
              return true;
            }
            return false;
          }).catch(() => {});
        }
      }

      const iframes = await page.$$('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]');
      for (const iframe of iframes) {
        const box = await iframe.boundingBox();
        if (box && box.width > 20 && box.height > 20) {
          const clickX = box.x + Math.min(30, box.width / 4);
          const clickY = box.y + box.height / 2;
          await page.mouse.click(clickX, clickY).catch(() => {});
        }
      }
    } catch {
      // Ignore cross-origin frame interaction warnings
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`  ⏳ Waiting for Cloudflare verification to resolve... (${elapsed}s)`);
    await sleep(3000);
  }

  const stillActive = await isCloudflareActive(page);
  return !stillActive;
}

export async function voteForBot(
  page: PageWithCursor,
  botId: string,
  accountName: string,
  config: AppConfig,
  username?: string,
  avatarUrl?: string
): Promise<VoteResult> {
  const timestamp = new Date().toISOString();
  const url = `https://top.gg/bot/${botId}/vote`;

  console.log(`  → Navigating to ${url}...`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.browserTimeoutSeconds * 1000 });
  } catch (err: any) {
    console.warn(`  ⚠️ Navigation warning: ${err.message}`);
  }

  await sleep(3000);

  const cfResolved = await resolveCloudflareChallenge(page, 60000);
  if (!cfResolved) {
    const screenshot = await captureScreenshot(page, `cf_blocked_${accountName}_${botId}`);
    return {
      accountName,
      username,
      avatarUrl,
      botId,
      status: 'FAILED',
      message: 'Cloudflare human verification (Turnstile) did not resolve in time',
      timestamp,
      screenshotPath: screenshot,
    };
  }

  await dismissPrivacyOverlay(page);
  await sleep(1500);

  let bodyText = await page.evaluate(() => (document.body ? document.body.innerText.toLowerCase() : ''));
  if (bodyText.includes('must be logged in') || bodyText.includes('login to vote')) {
    if (config.debug) console.log('  [dbg] Session not visible yet, refreshing page...');
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(3000);
    for (let i = 0; i < 3; i++) {
      await dismissPrivacyOverlay(page);
      await sleep(500);
    }
    bodyText = await page.evaluate(() => (document.body ? document.body.innerText.toLowerCase() : ''));
  }

  const pageTitle = await page.title();
  if (bodyText.includes('could not be found') || pageTitle.includes('404')) {
    const screenshot = await captureScreenshot(page, `404_${accountName}_${botId}`);
    return {
      accountName,
      username,
      avatarUrl,
      botId,
      status: 'FAILED',
      message: `Bot ID ${botId} not found (404)`,
      timestamp,
      screenshotPath: screenshot,
    };
  }

  const isAuth = await checkTopGGAuth(page);
  if (!isAuth && (bodyText.includes('must be logged in') || bodyText.includes('login to vote'))) {
    const screenshot = await captureScreenshot(page, `auth_failed_${accountName}_${botId}`);
    return {
      accountName,
      username,
      avatarUrl,
      botId,
      status: 'FAILED',
      message: 'Top.gg cookies expired or invalid (Authentication failed)',
      timestamp,
      screenshotPath: screenshot,
    };
  }

  const cooldownMarkers = [
    'vote again in',
    'already voted',
    'come back',
    'cooldown',
    'thanks for voting',
    'can vote again',
    'every 12 hours',
    'once every 12 hours',
  ];
  if (cooldownMarkers.some((marker) => bodyText.includes(marker))) {
    console.log(`  ⏳ Already voted for bot ${botId} (cooldown active)`);
    return {
      accountName,
      username,
      avatarUrl,
      botId,
      status: 'ALREADY_VOTED',
      message: 'Already voted on Top.gg, 12h cooldown active',
      timestamp,
    };
  }

  console.log('  → Waiting for countdown and locating Vote button...');
  const btnDeadline = Date.now() + 45000;
  let buttonFound = false;

  while (Date.now() < btnDeadline) {
    await dismissPrivacyOverlay(page);

    const btnState = await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll('button, a[role="button"], [role="button"]')
      ) as HTMLElement[];

      const btn = buttons.find((b) => {
        const text = (b.innerText || b.textContent || '').trim().toLowerCase();
        return text === 'vote' || text.startsWith('vote ');
      });

      if (!btn) {
        const countdownBtn = buttons.find((b) => /^[0-9]+$/.test((b.innerText || b.textContent || '').trim()));
        return {
          exists: false,
          disabled: true,
          countdown: countdownBtn ? (countdownBtn.innerText || countdownBtn.textContent || '').trim() : undefined,
        };
      }

      btn.setAttribute('data-auto-vote-btn', '1');
      const isDisabled =
        (btn as HTMLButtonElement).disabled ||
        btn.getAttribute('aria-disabled') === 'true' ||
        btn.classList.contains('disabled');

      return {
        exists: true,
        disabled: Boolean(isDisabled),
      };
    });

    if (btnState.exists && !btnState.disabled) {
      buttonFound = true;
      break;
    }

    if (btnState.countdown) {
      console.log(`  ⏳ Ad countdown in progress: ${btnState.countdown}s remaining...`);
    }

    await sleep(2000);
  }

  if (!buttonFound) {
    const screenshot = await captureScreenshot(page, `no_btn_${accountName}_${botId}`);
    return {
      accountName,
      username,
      avatarUrl,
      botId,
      status: 'FAILED',
      message: 'Vote button not found or remained disabled',
      timestamp,
      screenshotPath: screenshot,
    };
  }

  let voteApiResponse: any = null;
  const onResponse = async (res: any) => {
    try {
      const u = res.url();
      if (u.includes('graphql') || u.includes('/api/')) {
        const text = await res.text().catch(() => '');
        if (text.includes('voteEntity')) {
          voteApiResponse = JSON.parse(text);
          if (config.debug) {
            console.log('  [dbg] Top.gg GraphQL response:', text.slice(0, 200));
          }
        }
      }
    } catch {}
  };
  page.on('response', onResponse);

  const cleanupListener = () => {
    try {
      page.off('response', onResponse);
    } catch {}
  };

  console.log('  → Scrolling Vote button into view...');
  await page.evaluate(() => {
    const btn = document.querySelector('[data-auto-vote-btn="1"]') as HTMLElement | null;
    if (btn) {
      btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }).catch(() => {});
  await sleep(600);

  console.log('  → Clicking Vote button with authentic cursor...');
  let clicked = false;
  try {
    if (typeof (page as any).realClick === 'function') {
      await (page as any).realClick('[data-auto-vote-btn="1"]');
      clicked = true;
    }
  } catch (err: any) {
    if (config.debug) console.log(`  [dbg] realClick notice: ${err.message}`);
  }

  if (!clicked) {
    try {
      const btnHandle = await page.$('[data-auto-vote-btn="1"]');
      if (btnHandle) {
        const box = await btnHandle.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          clicked = true;
        }
      }
    } catch {}
  }

  await page.evaluate(() => {
    const btn = document.querySelector('[data-auto-vote-btn="1"]') as HTMLButtonElement | null;
    if (btn) {
      btn.click();
    }
  }).catch(() => {});

  console.log('  → Waiting for vote confirmation from Top.gg...');
  const verifyDeadline = Date.now() + 18000;
  const clickTime = Date.now();
  let reclicked = false;
  const successMarkers = [
    'thanks for voting',
    'thank you',
    'already voted',
    'vote again in',
    'can vote again',
    'every 12 hours',
    'set a reminder so we can let you know',
  ];

  while (Date.now() < verifyDeadline) {
    await sleep(1200);

    if (voteApiResponse?.data?.voteEntity?.isAcknowledged === true) {
      console.log(`  ✅ Successfully voted for bot ${botId} (API confirmed)`);
      cleanupListener();
      return {
        accountName,
        username,
        avatarUrl,
        botId,
        status: 'SUCCESS',
        message: 'Vote recorded successfully!',
        timestamp,
      };
    }

    bodyText = await page.evaluate(() => (document.body ? document.body.innerText.toLowerCase() : ''));
    if (successMarkers.some((marker) => bodyText.includes(marker))) {
      console.log(`  ✅ Successfully voted for bot ${botId}`);
      cleanupListener();
      return {
        accountName,
        username,
        avatarUrl,
        botId,
        status: 'SUCCESS',
        message: 'Vote recorded successfully!',
        timestamp,
      };
    }

    if (!reclicked && Date.now() - clickTime > 5000) {
      const isStillVoteBtn = await page.evaluate(() => {
        const btn = document.querySelector('[data-auto-vote-btn="1"]') as HTMLElement | null;
        if (!btn) return false;
        const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
        return text === 'vote' || text.startsWith('vote ');
      });

      if (isStillVoteBtn) {
        console.log('  🔄 Vote button still active, re-dispatching click...');
        reclicked = true;
        try {
          if (typeof (page as any).realClick === 'function') {
            await (page as any).realClick('[data-auto-vote-btn="1"]');
          } else {
            await page.click('[data-auto-vote-btn="1"]');
          }
        } catch {}
      }
    }

    if (await isCloudflareActive(page)) {
      console.log('  🛡️ Cloudflare verification appeared after vote click, attempting resolution...');
      await resolveCloudflareChallenge(page, 20000);
    }
  }

  console.log('  → Checking final vote status...');
  bodyText = await page.evaluate(() => (document.body ? document.body.innerText.toLowerCase() : ''));
  if (
    voteApiResponse?.data?.voteEntity?.isAcknowledged === true ||
    successMarkers.some((marker) => bodyText.includes(marker))
  ) {
    cleanupListener();
    return {
      accountName,
      username,
      avatarUrl,
      botId,
      status: 'SUCCESS',
      message: 'Vote recorded and verified successfully!',
      timestamp,
    };
  }

  if (bodyText.includes('vote again in') || bodyText.includes('can vote again')) {
    cleanupListener();
    return {
      accountName,
      username,
      avatarUrl,
      botId,
      status: 'ALREADY_VOTED',
      message: 'Vote was accepted (cooldown now active)',
      timestamp,
    };
  }

  cleanupListener();
  const uncertainScreenshot = await captureScreenshot(page, `uncertain_${accountName}_${botId}`);
  return {
    accountName,
    username,
    avatarUrl,
    botId,
    status: 'FAILED',
    message: 'Vote status could not be verified after submission',
    timestamp,
    screenshotPath: uncertainScreenshot,
  };
}
