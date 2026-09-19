export interface TopGGCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  [key: string]: any;
}

export interface VoteRecord {
  lastVotedAt: string; // ISO string
  nextAvailableAt: string; // ISO string (+12 hours)
  status: 'SUCCESS' | 'ALREADY_VOTED' | 'FAILED';
  message?: string;
}

export interface AccountRecord {
  [botId: string]: VoteRecord;
}

export interface DatabaseSchema {
  accounts: {
    [accountName: string]: AccountRecord;
  };
  lastUpdated: string;
}

export interface VoteResult {
  accountName: string;
  username?: string;
  avatarUrl?: string;
  botId: string;
  status: 'SUCCESS' | 'ALREADY_VOTED' | 'FAILED';
  message: string;
  timestamp: string;
  screenshotPath?: string;
}

export interface ProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface AppConfig {
  botIds: string[];
  discordWebhookUrl?: string;
  debug: boolean;
  sendErrorScreenshots: boolean;
  headless: boolean;
  onceMode: boolean;
  minAccountDelaySeconds: number;
  maxAccountDelaySeconds: number;
  botDelaySeconds: number;
  browserTimeoutSeconds: number;
  chromePath?: string;
  proxy?: ProxyConfig;
}
