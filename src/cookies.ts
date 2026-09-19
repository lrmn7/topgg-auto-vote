import * as fs from 'fs';
import * as path from 'path';
import { TopGGCookie } from './types';

export interface AccountCookieData {
  accountName: string;
  username?: string;
  avatarUrl?: string;
  cookies: TopGGCookie[];
  hasAuthToken: boolean;
}

/**
 * Decodes the Discord username and avatar URL from the Top.gg Auth.js JWT session token
 */
export function extractUserDataFromCookies(cookies: TopGGCookie[]): { username?: string; avatarUrl?: string } {
  const sessionCookie = cookies.find((c) => c.name.includes('session-token'));
  if (!sessionCookie || !sessionCookie.value) return {};

  try {
    const parts = sessionCookie.value.split('.');
    if (parts.length >= 2) {
      const payloadStr = Buffer.from(parts[1], 'base64').toString('utf-8');
      const payload = JSON.parse(payloadStr);
      return {
        username: payload.name || payload.username || undefined,
        avatarUrl: payload.picture || payload.image || undefined,
      };
    }
  } catch {}

  return {};
}

/**
 * Normalizes cookie object into Puppeteer compatible cookie format
 */
export function normalizeCookie(raw: any): TopGGCookie | null {
  if (!raw || typeof raw !== 'object' || !raw.name || raw.value === undefined) {
    return null;
  }

  let domain = raw.domain || '.top.gg';
  if (domain && !domain.includes('top.gg')) {
    return null;
  }

  let sameSite: 'Strict' | 'Lax' | 'None' | undefined = undefined;
  if (raw.sameSite) {
    const s = String(raw.sameSite).toLowerCase();
    if (s === 'strict') sameSite = 'Strict';
    else if (s === 'lax') sameSite = 'Lax';
    else if (s === 'none' || s === 'no_restriction') sameSite = 'None';
  }

  let expires: number | undefined = undefined;
  const rawExpires = raw.expirationDate ?? raw.expires;
  if (typeof rawExpires === 'number' && !isNaN(rawExpires)) {
    expires = Math.floor(rawExpires);
  }

  return {
    name: String(raw.name),
    value: String(raw.value),
    domain: domain.startsWith('.') ? domain : `.${domain}`,
    path: raw.path || '/',
    expires,
    httpOnly: Boolean(raw.httpOnly),
    secure: raw.secure !== undefined ? Boolean(raw.secure) : true,
    ...(sameSite ? { sameSite } : {}),
  };
}

/**
 * Parses raw JSON string or object into an array of TopGGCookie
 */
export function parseRawCookies(content: string | any[]): TopGGCookie[] {
  let parsed: any;
  if (typeof content === 'string') {
    try {
      parsed = JSON.parse(content);
    } catch {
      return [];
    }
  } else {
    parsed = content;
  }

  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.cookies)
    ? parsed.cookies
    : [];

  const validCookies: TopGGCookie[] = [];
  for (const item of items) {
    const norm = normalizeCookie(item);
    if (norm) {
      validCookies.push(norm);
    }
  }

  return validCookies;
}

/**
 * Parses cookies from an environment variable string
 */
function parseCookiesFromEnvValue(envVal: string, defaultName: string): AccountCookieData[] {
  let jsonText = envVal.trim();
  if (jsonText.startsWith('ey') || jsonText.startsWith('Ww')) {
    try {
      jsonText = Buffer.from(jsonText, 'base64').toString('utf-8');
    } catch {}
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }

  const results: AccountCookieData[] = [];

  if (Array.isArray(parsed) && parsed.length > 0 && Array.isArray(parsed[0])) {
    parsed.forEach((subArray, idx) => {
      const cookies = parseRawCookies(subArray);
      if (cookies.length > 0) {
        const { username, avatarUrl } = extractUserDataFromCookies(cookies);
        results.push({
          accountName: `${defaultName}-${idx + 1}`,
          username,
          avatarUrl,
          cookies,
          hasAuthToken: cookies.some(
            (c) => c.name.includes('session-token') || c.name.includes('authjs')
          ),
        });
      }
    });
    return results;
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !parsed.cookies && !parsed.name) {
    for (const [key, val] of Object.entries(parsed)) {
      if (Array.isArray(val)) {
        const cookies = parseRawCookies(val);
        if (cookies.length > 0) {
          const { username, avatarUrl } = extractUserDataFromCookies(cookies);
          results.push({
            accountName: key,
            username,
            avatarUrl,
            cookies,
            hasAuthToken: cookies.some(
              (c) => c.name.includes('session-token') || c.name.includes('authjs')
            ),
          });
        }
      }
    }
    if (results.length > 0) return results;
  }

  const cookies = parseRawCookies(parsed);
  if (cookies.length > 0) {
    const { username, avatarUrl } = extractUserDataFromCookies(cookies);
    results.push({
      accountName: defaultName,
      username,
      avatarUrl,
      cookies,
      hasAuthToken: cookies.some(
        (c) => c.name.includes('session-token') || c.name.includes('authjs')
      ),
    });
  }

  return results;
}

/**
 * Loads all account cookies from the cookies directory or env fallback
 */
export function loadAllAccountCookies(cookiesDirPath?: string): AccountCookieData[] {
  const dir = cookiesDirPath || path.resolve(process.cwd(), 'cookies');
  const accounts: AccountCookieData[] = [];

  if (fs.existsSync(dir)) {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    for (const file of files) {
      const fullPath = path.join(dir, file);
      const accountName = path.basename(file, '.json');
      try {
        const rawText = fs.readFileSync(fullPath, 'utf-8');
        const parsedAccounts = parseCookiesFromEnvValue(rawText, accountName);
        accounts.push(...parsedAccounts);
      } catch (err: any) {
        console.error(`[CookieLoader] Failed to read ${file}: ${err.message}`);
      }
    }
  }

  if (accounts.length === 0) {
    const primaryEnv = process.env.TOPGG_COOKIES || process.env.COOKIES;
    if (primaryEnv) {
      const parsedAccounts = parseCookiesFromEnvValue(primaryEnv, 'account-1');
      accounts.push(...parsedAccounts);
    }

    for (const key of Object.keys(process.env)) {
      if (/^TOPGG_COOKIES_\d+$/i.test(key)) {
        const val = process.env[key];
        if (val) {
          const accountName = key.toLowerCase().replace('topgg_cookies_', 'account-');
          const parsed = parseCookiesFromEnvValue(val, accountName);
          accounts.push(...parsed);
        }
      }
    }
  }

  return accounts;
}
