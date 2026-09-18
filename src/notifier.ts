import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import FormData from 'form-data';
import { VoteResult } from './types';

export class DiscordNotifier {
  private webhookUrl?: string;
  private sendScreenshots: boolean;

  constructor(webhookUrl?: string, sendScreenshots: boolean = true) {
    this.webhookUrl = webhookUrl;
    this.sendScreenshots = sendScreenshots;
  }

  /**
   * Sends a vote result notification to Discord
   */
  public async sendVoteResult(result: VoteResult): Promise<void> {
    if (!this.webhookUrl) {
      return;
    }

    try {
      const isSuccess = result.status === 'SUCCESS';
      const isAlreadyVoted = result.status === 'ALREADY_VOTED';
      
      let color = 0x2ecc71; // Green
      let title = `✅ Top.gg Vote Successful`;
      if (isAlreadyVoted) {
        color = 0xf1c40f; // Yellow / Gold
        title = `⏳ Top.gg Already Voted (Cooldown Active)`;
      } else if (!isSuccess) {
        color = 0xe74c3c; // Red
        title = `❌ Top.gg Vote Failed`;
      }

      const accountLabel = result.username
        ? `**${result.username}** (\`${result.accountName}\`)`
        : `\`${result.accountName}\``;

      const fields = [
        { name: '👤 Account', value: accountLabel, inline: true },
        { name: '🤖 Bot ID', value: `\`${result.botId}\``, inline: true },
        { name: '📊 Status', value: `**${result.status}**`, inline: true },
        { name: '📝 Message', value: result.message || 'No additional details' },
        { name: '⏰ Timestamp', value: `<t:${Math.floor(new Date(result.timestamp).getTime() / 1000)}:F>` },
      ];

      const embed: any = {
        title,
        color,
        fields,
        footer: { text: 'Top.gg Auto-Vote' },
        timestamp: new Date().toISOString(),
      };

      if (result.avatarUrl) {
        embed.thumbnail = { url: result.avatarUrl };
        embed.author = { name: result.username || result.accountName, icon_url: result.avatarUrl };
      }

      const hasScreenshot =
        this.sendScreenshots &&
        result.screenshotPath &&
        fs.existsSync(result.screenshotPath);

      if (hasScreenshot && result.screenshotPath) {
        const fileName = path.basename(result.screenshotPath);
        embed.image = { url: `attachment://${fileName}` };

        const form = new FormData();
        form.append('payload_json', JSON.stringify({ embeds: [embed] }));
        form.append('files[0]', fs.createReadStream(result.screenshotPath), fileName);

        await axios.post(this.webhookUrl, form, {
          headers: form.getHeaders(),
          timeout: 15000,
        });
      } else {
        await axios.post(
          this.webhookUrl,
          { embeds: [embed] },
          { timeout: 15000 }
        );
      }
    } catch (err: any) {
      console.error(`[Notifier] Failed to send Discord webhook: ${err.message}`);
    }
  }

  /**
   * Sends a general summary or error alert to Discord
   */
  public async sendAlert(title: string, message: string, isError: boolean = false): Promise<void> {
    if (!this.webhookUrl) return;

    try {
      const embed = {
        title: (isError ? '⚠️ ' : 'ℹ️ ') + title,
        description: message,
        color: isError ? 0xe74c3c : 0x3498db,
        footer: { text: 'Top.gg Auto-Vote' },
        timestamp: new Date().toISOString(),
      };

      await axios.post(this.webhookUrl, { embeds: [embed] }, { timeout: 15000 });
    } catch (err: any) {
      console.error(`[Notifier] Failed to send Discord alert: ${err.message}`);
    }
  }

  /**
   * Sends a notice when an account/bot is currently on cooldown
   */
  public async sendCooldownNotice(
    accountName: string,
    username: string | undefined,
    avatarUrl: string | undefined,
    botId: string,
    remainingHours: number,
    remainingMinutes: number
  ): Promise<void> {
    if (!this.webhookUrl) return;

    try {
      const accountLabel = username ? `**${username}** (\`${accountName}\`)` : `\`${accountName}\``;
      const embed: any = {
        title: '⏳ Top.gg Cooldown Active',
        color: 0x3498db, // Blue
        fields: [
          { name: '👤 Account', value: accountLabel, inline: true },
          { name: '🤖 Bot ID', value: `\`${botId}\``, inline: true },
          { name: '⏳ Remaining Time', value: `**${remainingHours}h ${remainingMinutes}m**`, inline: true },
          {
            name: 'ℹ️ Status',
            value: 'Skipping vote check. Bot will vote automatically when 12h cooldown expires.',
          },
        ],
        footer: { text: 'Top.gg Auto-Vote' },
        timestamp: new Date().toISOString(),
      };

      if (avatarUrl) {
        embed.thumbnail = { url: avatarUrl };
        embed.author = { name: username || accountName, icon_url: avatarUrl };
      }

      await axios.post(this.webhookUrl, { embeds: [embed] }, { timeout: 15000 });
    } catch (err: any) {
      console.error(`[Notifier] Failed to send cooldown notice: ${err.message}`);
    }
  }
}
