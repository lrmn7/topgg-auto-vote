import { AppConfig, VoteResult } from './types';
import { loadAllAccountCookies } from './cookies';
import { VoteDatabase } from './database';
import { DiscordNotifier } from './notifier';
import { createBrowserSession, closeBrowserSession, injectCookies } from './browser';
import { voteForBot } from './voter';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function getRandomDelay(minSeconds: number, maxSeconds: number): number {
  return Math.floor(Math.random() * (maxSeconds - minSeconds + 1)) + minSeconds;
}

export class VoteQueueRunner {
  private config: AppConfig;
  private db: VoteDatabase;
  private notifier: DiscordNotifier;

  constructor(config: AppConfig, db: VoteDatabase, notifier: DiscordNotifier) {
    this.config = config;
    this.db = db;
    this.notifier = notifier;
  }

  /**
   * Executes a single pass over all accounts and bots
   */
  public async runQueueCycle(): Promise<VoteResult[]> {
    const accounts = loadAllAccountCookies();
    const results: VoteResult[] = [];

    console.log('\n' + '═'.repeat(60));
    console.log(`📋 Starting Queue Cycle with ${accounts.length} account(s) and ${this.config.botIds.length} bot(s)`);
    console.log(`⏰ Current Time: ${new Date().toLocaleString()}`);
    console.log('═'.repeat(60) + '\n');

    if (accounts.length === 0) {
      console.warn('⚠️ No cookie accounts found in cookies/ directory or environment variables!');
      return results;
    }

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      const accountDisplayName = account.username
        ? `${account.username} (${account.accountName})`
        : account.accountName;

      console.log(`\n────────────────────────────────────────────────────────────`);
      console.log(`👤 [Account ${i + 1}/${accounts.length}]: ${accountDisplayName}`);
      console.log(`────────────────────────────────────────────────────────────`);

      // Determine eligible bots for this account
      const eligibleBots: string[] = [];
      for (const botId of this.config.botIds) {
        const eligibility = this.db.isEligibleToVote(account.accountName, botId);
        if (eligibility.eligible) {
          eligibleBots.push(botId);
        } else {
          console.log(
            `  ⏳ Bot ${botId}: Cooldown active (${eligibility.remainingHours}h ${eligibility.remainingMinutes}m remaining). Skipping.`
          );
          // Send notification to Discord so user is informed of current cooldown status
          await this.notifier.sendCooldownNotice(
            account.accountName,
            account.username,
            account.avatarUrl,
            botId,
            eligibility.remainingHours || 0,
            eligibility.remainingMinutes || 0
          );
        }
      }

      if (eligibleBots.length === 0) {
        console.log(`  ℹ️ All bots are currently on cooldown for account ${accountDisplayName}.`);
        continue;
      }

      console.log(`  🎯 ${eligibleBots.length} bot(s) ready to vote: ${eligibleBots.join(', ')}`);

      let session;
      try {
        console.log(`  🚀 Launching browser session...`);
        session = await createBrowserSession(this.config);

        console.log(`  🍪 Injecting ${account.cookies.length} cookie(s)...`);
        await injectCookies(session.page, account.cookies);

        for (let b = 0; b < eligibleBots.length; b++) {
          const botId = eligibleBots[b];
          console.log(`\n  [Bot ${b + 1}/${eligibleBots.length}] Voting for bot ID: ${botId}...`);

          const voteResult = await voteForBot(
            session.page,
            botId,
            account.accountName,
            this.config,
            account.username,
            account.avatarUrl
          );
          results.push(voteResult);

          // Update database
          this.db.recordVote(
            account.accountName,
            botId,
            voteResult.status,
            voteResult.message
          );

          // Send Discord notification
          await this.notifier.sendVoteResult(voteResult);

          // Delay between bots for the same account (default 60s)
          if (b < eligibleBots.length - 1) {
            console.log(`\n  ⏳ Waiting ${this.config.botDelaySeconds}s before next bot...`);
            await sleep(this.config.botDelaySeconds * 1000);
          }
        }
      } catch (err: any) {
        console.error(`  ❌ Error processing account ${accountDisplayName}: ${err.message}`);
        const errResult: VoteResult = {
          accountName: account.accountName,
          username: account.username,
          avatarUrl: account.avatarUrl,
          botId: 'all',
          status: 'FAILED',
          message: `Unhandled account error: ${err.message}`,
          timestamp: new Date().toISOString(),
        };
        await this.notifier.sendVoteResult(errResult);
      } finally {
        if (session) {
          console.log(`  🔒 Closing browser session for ${accountDisplayName}...`);
          await closeBrowserSession(session);
        }
      }

      // Safe delay between accounts (random 2-3 minutes)
      if (i < accounts.length - 1) {
        const delaySec = getRandomDelay(
          this.config.minAccountDelaySeconds,
          this.config.maxAccountDelaySeconds
        );
        console.log(`\n🛡️ Safedelay: Waiting ${delaySec} seconds (~${Math.round(delaySec / 60)} min) before next account...`);
        await sleep(delaySec * 1000);
      }
    }

    console.log('\n' + '═'.repeat(60));
    console.log(`🏁 Finished Queue Cycle. Processed ${results.length} vote action(s).`);
    console.log('═'.repeat(60) + '\n');

    return results;
  }
}
