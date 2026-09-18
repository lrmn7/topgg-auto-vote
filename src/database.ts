import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSchema, VoteRecord } from './types';

const COOLDOWN_HOURS = 12;
const COOLDOWN_MS = COOLDOWN_HOURS * 60 * 60 * 1000;

export class VoteDatabase {
  private filePath: string;
  private data: DatabaseSchema;

  constructor(dbPath?: string) {
    this.filePath = dbPath || path.resolve(process.cwd(), 'data', 'database.json');
    this.data = this.load();
    this.ensureInitialized();
  }

  private load(): DatabaseSchema {
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8').trim();
        if (content) {
          const parsed = JSON.parse(content);
          return {
            accounts:
              parsed && typeof parsed.accounts === 'object' && parsed.accounts !== null
                ? parsed.accounts
                : {},
            lastUpdated: parsed?.lastUpdated || new Date().toISOString(),
          };
        }
      }
    } catch (err: any) {
      console.warn(`[Database] Could not read database, initializing fresh: ${err.message}`);
    }

    return {
      accounts: {},
      lastUpdated: new Date().toISOString(),
    };
  }

  private ensureInitialized(): void {
    if (!this.data || typeof this.data !== 'object') {
      this.data = { accounts: {}, lastUpdated: new Date().toISOString() };
    }
    if (!this.data.accounts || typeof this.data.accounts !== 'object') {
      this.data.accounts = {};
    }
  }

  private save(): void {
    try {
      this.ensureInitialized();
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.data.lastUpdated = new Date().toISOString();
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (err: any) {
      console.error(`[Database] Failed to write database: ${err.message}`);
    }
  }

  /**
   * Retrieves the vote record for an account and bot
   */
  public getRecord(accountName: string, botId: string): VoteRecord | null {
    this.ensureInitialized();
    return this.data.accounts?.[accountName]?.[botId] || null;
  }

  /**
   * Checks if an account is eligible to vote for a specific bot (12-hour cooldown check)
   */
  public isEligibleToVote(
    accountName: string,
    botId: string
  ): {
    eligible: boolean;
    remainingHours?: number;
    remainingMinutes?: number;
    nextAvailableAt?: string;
  } {
    const record = this.getRecord(accountName, botId);
    if (!record || record.status === 'FAILED') {
      return { eligible: true };
    }

    const nextAvailableTime = new Date(record.nextAvailableAt).getTime();
    const now = Date.now();

    if (now < nextAvailableTime) {
      const diffMs = nextAvailableTime - now;
      const remainingHours = Math.floor(diffMs / (60 * 60 * 1000));
      const remainingMinutes = Math.floor((diffMs % (60 * 60 * 1000)) / (60 * 1000));
      return {
        eligible: false,
        remainingHours,
        remainingMinutes,
        nextAvailableAt: record.nextAvailableAt,
      };
    }

    return { eligible: true };
  }

  /**
   * Records a vote outcome in the database
   */
  public recordVote(
    accountName: string,
    botId: string,
    status: 'SUCCESS' | 'ALREADY_VOTED' | 'FAILED',
    message?: string
  ): void {
    this.ensureInitialized();
    if (!this.data.accounts[accountName] || typeof this.data.accounts[accountName] !== 'object') {
      this.data.accounts[accountName] = {};
    }

    const now = new Date();
    const nextAvailable = new Date(now.getTime() + COOLDOWN_MS);

    this.data.accounts[accountName][botId] = {
      lastVotedAt: now.toISOString(),
      nextAvailableAt: nextAvailable.toISOString(),
      status,
      message,
    };

    this.save();
  }

  /**
   * Returns complete overview of all accounts in the database
   */
  public getAllRecords(): DatabaseSchema['accounts'] {
    this.ensureInitialized();
    return this.data.accounts || {};
  }
}
