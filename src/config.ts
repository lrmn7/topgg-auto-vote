import * as dotenv from 'dotenv';
import * as path from 'path';
import { AppConfig } from './types';

// Load .env from project root
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function parseBool(val: string | undefined, defaultVal: boolean): boolean {
  if (val === undefined || val === '') return defaultVal;
  return val === '1' || val.toLowerCase() === 'true' || val.toLowerCase() === 'yes';
}

function parseNumber(val: string | undefined, defaultVal: number): number {
  if (!val) return defaultVal;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? defaultVal : parsed;
}

export function loadConfig(): AppConfig {
  const args = process.argv.slice(2);
  const isOnceArg = args.includes('--once') || args.includes('-o');
  const isDebugArg = args.includes('--debug') || args.includes('-d');
  const headlessArg = args.find((a) => a.startsWith('--headless='));

  // Bot IDs can be comma-separated in BOT_IDS or single in BOT_ID
  const rawBotIds = process.env.BOT_IDS || process.env.BOT_ID || '928711702596423740';
  const botIds = rawBotIds
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  let headless = true;
  if (headlessArg) {
    headless = parseBool(headlessArg.split('=')[1], true);
  } else if (process.env.HEADLESS !== undefined) {
    headless = parseBool(process.env.HEADLESS, true);
  }

  const debug = isDebugArg || parseBool(process.env.DEBUG, false);
  const onceMode = isOnceArg || parseBool(process.env.ONCE_MODE, false);
  const sendErrorScreenshots = parseBool(process.env.SEND_ERROR_SCREENSHOTS, true);
  const rawWebhook = process.env.DISCORD_WEBHOOK_URL?.trim();
  const discordWebhookUrl =
    rawWebhook &&
    !rawWebhook.includes('your/webhook/here') &&
    rawWebhook.startsWith('https://discord.com/api/webhooks')
      ? rawWebhook
      : undefined;

  const minAccountDelaySeconds = parseNumber(process.env.ACCOUNT_DELAY_MIN, 120); // 2 minutes
  const maxAccountDelaySeconds = parseNumber(process.env.ACCOUNT_DELAY_MAX, 180); // 3 minutes
  const botDelaySeconds = parseNumber(process.env.BOT_DELAY, 60); // 1 minute
  const browserTimeoutSeconds = parseNumber(process.env.BROWSER_TIMEOUT, 60);
  const chromePath =
    process.env.CHROME_PATH?.trim() ||
    process.env.BROWSER_PATH?.trim() ||
    process.env.PUPPETEER_EXECUTABLE_PATH?.trim() ||
    process.env.CHROMIUM_PATH?.trim() ||
    undefined;

  return {
    botIds,
    discordWebhookUrl,
    debug,
    sendErrorScreenshots,
    headless,
    onceMode,
    minAccountDelaySeconds,
    maxAccountDelaySeconds,
    botDelaySeconds,
    browserTimeoutSeconds,
    chromePath,
  };
}
