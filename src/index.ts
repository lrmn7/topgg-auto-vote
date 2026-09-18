import { loadConfig } from './config';
import { VoteDatabase } from './database';
import { DiscordNotifier } from './notifier';
import { VoteQueueRunner } from './queue';

// Global error shields to prevent process crashes from harmless subprocess signals in minimal environments
process.on('uncaughtException', (err: any) => {
  if (err?.code === 'ENOENT' && (err?.syscall === 'spawn ps' || err?.path === 'ps' || err?.message?.includes('spawn ps'))) {
    // Harmless ENOENT from tree-kill in environments without procps/ps
    return;
  }
  console.error('Fatal crash in main process:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason: any) => {
  console.warn('⚠️ Unhandled promise rejection:', reason);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const config = loadConfig();
  const db = new VoteDatabase();
  const notifier = new DiscordNotifier(config.discordWebhookUrl, config.sendErrorScreenshots);
  const runner = new VoteQueueRunner(config, db, notifier);

  console.log('🚀 Top.gg Auto-Vote Starting');
  console.log(`📌 Mode: ${config.onceMode ? 'Single Run (--once)' : 'Continuous Daemon'}`);
  console.log(`🤖 Target Bot IDs: ${config.botIds.join(', ')}`);
  console.log(`⏱️ Account Delay: ${config.minAccountDelaySeconds}s - ${config.maxAccountDelaySeconds}s`);
  console.log(`⏱️ Bot Delay: ${config.botDelaySeconds}s`);
  console.log(`📢 Discord Webhook: ${config.discordWebhookUrl ? 'Configured ✅' : 'Disabled (No URL)'}`);
  console.log(`🖥️ Browser Mode: ${config.headless ? 'Headless' : 'Visible (GUI)'}`);

  // Graceful shutdown handling
  let isShuttingDown = false;
  const handleExit = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('\n🛑 Gracefully shutting down Top.gg Auto-Vote Engine...');
    process.exit(0);
  };
  process.on('SIGINT', handleExit);
  process.on('SIGTERM', handleExit);

  if (config.onceMode) {
    console.log('\n🏃 Running single cycle (--once flag detected)...');
    const results = await runner.runQueueCycle();
    const hasFailures = results.some((r) => r.status === 'FAILED');
    console.log(`✨ Single run complete with ${results.length} action(s).`);
    process.exit(hasFailures ? 1 : 0);
  } else {
    console.log('\n🔄 Continuous daemon loop active. Bot will check and vote automatically.');

    while (!isShuttingDown) {
      try {
        await runner.runQueueCycle();
      } catch (err: any) {
        console.error(`❌ Unexpected error during cycle: ${err.message}`);
      }

      // Check every 15 minutes if any account/bot becomes eligible
      const checkIntervalMinutes = 15;
      console.log(`\n💤 Sleeping for ${checkIntervalMinutes} minutes before next schedule check...`);
      await sleep(checkIntervalMinutes * 60 * 1000);
    }
  }
}

main().catch((err) => {
  console.error('Fatal crash in main process:', err);
  process.exit(1);
});
