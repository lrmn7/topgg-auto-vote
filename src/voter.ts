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

export interface VoteButtonInfo {
  handle: any;
  text: string;
  box: { x: number; y: number; width: number; height: number };
}

/**
 * Dynamically finds the active, enabled Vote button on the page.
 * Evaluates fresh elements on each call so it never breaks on React re-renders.
 */
export async function findVoteButton(page: PageWithCursor): Promise<VoteButtonInfo | null> {
  try {
    const candidateHandles = await page.$$('button, a[role="button"], [role="button"]');
    for (const el of candidateHandles) {
      try {
        const info: { text: string; disabled: boolean } | null = await page.evaluate((b: any) => {
          const el = b as HTMLElement;
          const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
          const lower = text.toLowerCase();

          const isVote =
            (lower === 'vote' || lower.startsWith('vote ') || lower.startsWith('vote(')) &&
            !lower.includes('already') &&
            !lower.includes('voted');

          if (!isVote) return null;

          const isDisabled =
            (el as HTMLButtonElement).disabled ||
            el.getAttribute('aria-disabled') === 'true' ||
            el.classList.contains('disabled') ||
            el.hasAttribute('disabled');

          return { text, disabled: Boolean(isDisabled) };
        }, el);

        if (info && !info.disabled) {
          const box = await el.boundingBox();
          if (box && box.width > 10 && box.height > 10) {
            return { handle: el, text: info.text, box };
          }
        }
      } catch {
        // Element may have detached/re-rendered; skip to next candidate
      }
    }
  } catch {}
  return null;
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

  console.log('  → Waiting for countdown and locating Vote button...');
  const btnDeadline = Date.now() + 45000;
  let buttonFound = false;

  while (Date.now() < btnDeadline) {
    await dismissPrivacyOverlay(page);

    const readyBtn = await findVoteButton(page);
    if (readyBtn) {
      console.log(`  🎯 Active Vote button found: "${readyBtn.text}"`);
      buttonFound = true;
      break;
    }

    const countdownInfo = await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll('button, a[role="button"], [role="button"]')
      ) as HTMLElement[];

      let countdown: string | undefined;
      let hasDisabledVote = false;

      for (const b of buttons) {
        const text = (b.innerText || b.textContent || '').trim();
        const digitMatch = text.match(/^\[?\(?(\d+)\s*s?\)?\]?$/);
        if (digitMatch && parseInt(digitMatch[1], 10) > 0 && parseInt(digitMatch[1], 10) <= 60) {
          countdown = digitMatch[1];
          break;
        }

        const lower = text.toLowerCase();
        if (lower === 'vote' || lower.startsWith('vote ') || lower.startsWith('vote(')) {
          const isDisabled =
            (b as HTMLButtonElement).disabled ||
            b.getAttribute('aria-disabled') === 'true' ||
            b.classList.contains('disabled') ||
            b.hasAttribute('disabled');
          if (isDisabled) {
            hasDisabledVote = true;
          }
        }
      }

      return { countdown, hasDisabledVote };
    }).catch(() => ({ countdown: undefined, hasDisabledVote: false }));

    if (countdownInfo?.countdown) {
      console.log(`  ⏳ Ad countdown in progress: ${countdownInfo.countdown}s remaining...`);
    } else if (countdownInfo?.hasDisabledVote) {
      console.log('  ⏳ Vote button is currently disabled, waiting for activation...');
    }

    await sleep(2000);
  }

  if (!buttonFound) {
    cleanupListener();
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

  await sleep(800);

  console.log('  → Locating Vote button for click...');
  let voteBtn = await findVoteButton(page);
  if (!voteBtn) {
    await sleep(1000);
    voteBtn = await findVoteButton(page);
  }

  if (voteBtn) {
    console.log(`  → Scrolling Vote button ("${voteBtn.text}") into view...`);
    try {
      await page.evaluate((el: any) => {
        (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, voteBtn.handle);
    } catch {}
    await sleep(600);
  }

  console.log('  → Clicking Vote button with authentic cursor...');
  let clicked = false;
  let clickMethod = '';

  if (voteBtn?.handle) {
    try {
      if (typeof (page as any).realClick === 'function') {
        await (page as any).realClick(voteBtn.handle);
        clicked = true;
        clickMethod = 'realClick(handle)';
      }
    } catch (err: any) {
      if (config.debug) console.log(`  [dbg] realClick(handle) error: ${err.message}`);
    }
  }

  if (!clicked && voteBtn?.box) {
    try {
      const clickX = voteBtn.box.x + voteBtn.box.width / 2;
      const clickY = voteBtn.box.y + voteBtn.box.height / 2;
      await page.mouse.click(clickX, clickY);
      clicked = true;
      clickMethod = 'mouse.click(box)';
    } catch (err: any) {
      if (config.debug) console.log(`  [dbg] mouse.click error: ${err.message}`);
    }
  }

  if (!clicked && voteBtn?.handle) {
    try {
      await voteBtn.handle.click();
      clicked = true;
      clickMethod = 'handle.click()';
    } catch (err: any) {
      if (config.debug) console.log(`  [dbg] handle.click error: ${err.message}`);
    }
  }

  if (!clicked) {
    try {
      const domClicked = await page.evaluate(() => {
        const buttons = Array.from(
          document.querySelectorAll('button, a[role="button"], [role="button"]')
        ) as HTMLElement[];
        const btn = buttons.find((b) => {
          const t = (b.innerText || b.textContent || '').trim().toLowerCase();
          const isDisabled =
            (b as HTMLButtonElement).disabled ||
            b.getAttribute('aria-disabled') === 'true' ||
            b.classList.contains('disabled') ||
            b.hasAttribute('disabled');
          return (t === 'vote' || t.startsWith('vote ') || t.startsWith('vote(')) && !isDisabled;
        });
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      if (domClicked) {
        clicked = true;
        clickMethod = 'DOM evaluate click';
      }
    } catch (err: any) {
      if (config.debug) console.log(`  [dbg] DOM evaluate click error: ${err.message}`);
    }
  }

  if (clicked) {
    console.log(`  👆 Vote button clicked via ${clickMethod}`);
  } else {
    console.warn('  ⚠️ Warning: All click methods failed to dispatch');
  }

  console.log('  → Waiting for vote confirmation from Top.gg...');
  const verifyDeadline = Date.now() + 25000;
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
    'you voted for',
    'vote successfully registered',
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

    if (!reclicked && Date.now() - clickTime > 10000) {
      const activeBtn = await findVoteButton(page);
      if (activeBtn) {
        console.log(`  🔄 Vote button still active after 10s ("${activeBtn.text}"), re-dispatching click...`);
        reclicked = true;
        try {
          if (typeof (page as any).realClick === 'function') {
            await (page as any).realClick(activeBtn.handle);
          } else if (activeBtn.box) {
            await page.mouse.click(activeBtn.box.x + activeBtn.box.width / 2, activeBtn.box.y + activeBtn.box.height / 2);
          } else {
            await activeBtn.handle.click();
          }
        } catch (err: any) {
          if (config.debug) console.log(`  [dbg] Re-click error: ${err.message}`);
        }
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
