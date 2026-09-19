import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { AppConfig, ProxyConfig } from './types';

// Dynamically resolve project root using __dirname (works anywhere: /home, /root, /opt, Windows, etc.)
const projectRoot = path.resolve(__dirname, '..');
const envPath = fs.existsSync(path.resolve(process.cwd(), '.env'))
  ? path.resolve(process.cwd(), '.env')
  : path.resolve(projectRoot, '.env');

dotenv.config({ path: envPath });

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

  let proxy: ProxyConfig | undefined;
  const rawProxyUrl = process.env.PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (rawProxyUrl) {
    try {
      const parsed = new URL(rawProxyUrl);
      proxy = {
        host: parsed.hostname,
        port: parseInt(parsed.port, 10) || 80,
        username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
        password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      };
    } catch {}
  } else if (process.env.PROXY_HOST) {
    const port = parseInt(process.env.PROXY_PORT || '80', 10);
    proxy = {
      host: process.env.PROXY_HOST.trim(),
      port: isNaN(port) ? 80 : port,
      username: process.env.PROXY_USERNAME?.trim() || process.env.PROXY_USER?.trim() || undefined,
      password: process.env.PROXY_PASSWORD?.trim() || process.env.PROXY_PASS?.trim() || undefined,
    };
  }

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
    proxy,
  };
}
