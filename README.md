# Top.gg Auto-Vote

An automated, multi-account, multi-bot voting engine for Top.gg built entirely in TypeScript and Node.js. It authenticates solely using raw session cookies (Auth.js JWT tokens), bypasses Cloudflare Turnstile, enforces randomized queue intervals to avoid bot detection, tracks 12-hour vote cooldowns via a local JSON database, and delivers rich reporting to Discord webhooks with failure screenshots.

Designed for flexible deployment across local machines, VPS instances, Docker containers, Pterodactyl Panel, and scheduled GitHub Actions workflows.

---

## Features

- Full TypeScript Architecture: Modular, typed codebase with clean separation between cookie ingestion, database persistence, browser automation, queue orchestration, and notification dispatch.
- Cookie-Only Authentication: No Discord bot tokens, client secrets, or manual OAuth flows required. Operates directly using exported Auth.js session cookies.
- Automatic Discord Profile Detection: Decodes the user profile (display name, user ID, avatar URL) directly from the Top.gg JWT session token without making external Discord API calls.
- Multi-Account Queue Management: Automatically detects all cookie files placed in the cookies directory or imported from environment secrets.
- Anti-Ban Timing Controls: Enforces a randomized interval of 120 to 180 seconds (2 to 3 minutes) between accounts, and a 60-second delay between distinct bots on the same account.
- Local 12-Hour Cooldown Database: Stores timestamp history in `data/database.json`. Automatically checks cooldown eligibility before launching a browser session, conserving CPU, memory, and bandwidth.
- Stealth Browser Automation: Powered by `puppeteer-real-browser` with automatic Cloudflare Turnstile detection, virtual display (`Xvfb`) on Linux runners, and off-screen positioning on Windows.
- Discord Webhook Notifications: Delivers structured embeds for successful votes, cooldown notices with countdown timers, and failure alerts with attached screenshot captures.
- Multi-Platform Deployment: Preconfigured for Local development, VPS management via PM2, Docker Compose, Pterodactyl Panel (Node.js Egg), and scheduled GitHub Actions workflows.

---

## Repository Structure

```text
auto-vote-topgg/
├── cookies/                     # Storage directory for account cookie JSON files
│   ├── .gitkeep
│   └── account1.json            # Sample cookie file
├── data/                        # Persistent database directory
│   ├── .gitkeep
│   └── database.json           # JSON database tracking vote cooldowns
├── dist/                        # Compiled JavaScript output
├── legacy-python/               # Archived Python implementation for reference
├── screenshots/                 # Captured error and captcha screenshots
├── src/
│   ├── browser.ts               # Stealth browser session launcher and cookie injector
│   ├── config.ts                # Environment variable and CLI argument parser
│   ├── cookies.ts               # Cookie reader, validator, and JWT profile parser
│   ├── database.ts              # Local JSON database manager and cooldown validator
│   ├── index.ts                 # Main entrypoint supporting daemon and single-run modes
│   ├── notifier.ts              # Discord webhook dispatcher for embeds and images
│   ├── queue.ts                 # Sequential queue runner with randomized timing intervals
│   ├── types.ts                 # Shared TypeScript interfaces and type definitions
│   └── voter.ts                 # Top.gg page navigation, ad countdown, and vote action
├── .env.example                 # Configuration template
├── .github/workflows/vote.yml   # Automated GitHub Actions workflow
├── .gitignore                   # Git exclusion rules protecting cookies and secrets
├── Dockerfile                   # Production Docker image with Chrome and Xvfb
├── docker-compose.yml           # Docker Compose deployment definition
├── package.json                 # Project dependencies and operational scripts
├── README.md                    # Project documentation
└── tsconfig.json                # TypeScript compiler configuration
```

---

## Configuration

Copy the sample environment file to `.env`:

```bash
cp .env.example .env
```

Edit the variables in `.env` to match your environment:

| Variable | Description | Default |
|---|---|---|
| `BOT_IDS` | Comma-separated list of target Top.gg bot IDs to vote for | `928711702596423740` |
| `DISCORD_WEBHOOK_URL` | Discord webhook URL for status reports and screenshot alerts | *(Optional)* |
| `SEND_ERROR_SCREENSHOTS` | Attach error screenshots to Discord on failure (`1` for enabled, `0` for disabled) | `1` |
| `DEBUG` | Enable verbose diagnostic logging (`1` for enabled, `0` for disabled) | `0` |
| `HEADLESS` | Run browser in background mode (`true` or `false`) | `true` |
| `ACCOUNT_DELAY_MIN` | Minimum random delay between accounts in seconds | `120` |
| `ACCOUNT_DELAY_MAX` | Maximum random delay between accounts in seconds | `180` |
| `BOT_DELAY` | Fixed delay between distinct bots on the same account in seconds | `60` |
| `CHROME_PATH` | Path to Chrome or Chromium binary (required on Pterodactyl if not in PATH) | Auto-detect |

---

## Obtaining Session Cookies

Top.gg utilizes Next.js and Auth.js session cookies (`__Secure-authjs.session-token`).

1. Open your browser (Chrome, Edge, or Brave) and navigate to https://top.gg.
2. Log in with your Discord account.
3. Install [Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc) from Chrome Web Store first. Cookie export stays local to browser according to extension listing, but exported Auth.js session data remains a sensitive login credential.
4. Export the cookies for the `top.gg` domain in JSON format.
5. Save the resulting JSON file directly into the `cookies/` directory with any descriptive filename ending in `.json` (for example: `cookies/account1.json`).
6. Repeat this process for each account you wish to automate.

The loader automatically reads raw JSON exports directly without requiring manual formatting or trimming.

---

## Multi-Account Setup

### Method 1: File-Based (Local, VPS, Docker, Pterodactyl, or Private Repositories)

Place individual JSON cookie files inside the `cookies/` folder:

- `cookies/account1.json`
- `cookies/account2.json`
- `cookies/account3.json`

The bot reads all `.json` files in alphabetical order, extracts the associated Discord profile name and avatar, and votes sequentially.

### Method 2: GitHub Actions Secrets (Dynamic Detection)

When running on GitHub Actions, you do not need to commit sensitive cookies to Git. Store them as Repository Secrets under `Settings > Secrets and variables > Actions`.

The workflow dynamically detects any secret whose name begins with `TOPGG_COOKIE`:

- Secret `TOPGG_COOKIES` : Raw JSON cookies of Account 1
- Secret `TOPGG_COOKIE_2` : Raw JSON cookies of Account 2
- Secret `TOPGG_COOKIE_3` : Raw JSON cookies of Account 3
- Secret `TOPGG_COOKIE_ANY_NAME` : Raw JSON cookies of Account N

You may also combine multiple accounts into a single `TOPGG_COOKIES` secret using either a JSON Array of Arrays or a JSON Object map:

```json
[
  [ { "name": "_pubcid", ... }, { "name": "__Secure-authjs.session-token", "value": "..." } ],
  [ { "name": "_pubcid", ... }, { "name": "__Secure-authjs.session-token", "value": "..." } ]
]
```

---

## Running the Application

### 1. Local Environment (Windows, macOS, Linux)

Requirements: Node.js version 18 or 20+, and Google Chrome installed.

```bash
# Install dependencies
npm install

# Build TypeScript to JavaScript
npm run build

# Option A: Run a single pass across all accounts and exit
npm run start:once

# Option B: Run in continuous 24/7 daemon mode
npm run start

# Option C: Build and start in one command
npm run start:prod
```

### 2. VPS Deployment

#### Option A: Process Manager (PM2)

```bash
# Install system prerequisites
sudo apt-get update && sudo apt-get install -y xvfb google-chrome-stable
npm install -g pm2

# Install project dependencies and compile
npm install
npm run build

# Start daemon process
pm2 start dist/index.js --name "topgg-voter"

# Save process list for system reboot
pm2 save
pm2 startup
```

#### Option B: Docker Compose

```bash
# Start container in detached mode
docker compose up -d --build

# Inspect operational logs
docker compose logs -f
```

### 3. Pterodactyl Panel

Running headless browser automation inside Pterodactyl requires a container image that contains Chromium and its necessary graphics libraries.

1. **Docker Image Selection**:
   - Navigate to the **Startup** tab in your Pterodactyl Panel.
   - If your hosting provider allows modifying the Docker Image, change it to:
     ```text
     ghcr.io/parkervcp/yolks:puppeteer
     ```
   - This official image comes pre-installed with Node.js, Chromium (`/usr/bin/chromium`), Xvfb, and all required Linux graphics libraries.

2. **Configuration (`.env`)**:
   - In your `.env` file, configure your bot settings and set the Chromium path:
     ```env
     BOT_IDS=928711702596423740
     DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
     HEADLESS=true
     CHROME_PATH=/usr/bin/chromium
     ```

3. **Startup Command**:
   - Under the Startup tab, ensure the Startup Command is:
     ```bash
     npm run start:prod
     ```

4. **Run the Bot**:
   - Start the server from the Console tab. The bot automatically compiles TypeScript and launches the continuous voting cycle.

### 4. GitHub Actions (Automated Cloud Scheduling)

The repository includes a GitHub Actions workflow located at `.github/workflows/vote.yml`.

1. Go to your repository on GitHub.
2. Navigate to `Settings > Secrets and variables > Actions` and configure the following secrets:
   - `BOT_IDS`: Your target bot ID or IDs.
   - `DISCORD_WEBHOOK_URL`: Your Discord webhook endpoint.
   - `TOPGG_COOKIES`: Raw JSON string of your account cookies.
3. The workflow runs on a cron schedule twice per day (every 12 hours):
   - 00:00 UTC (07:00 WIB)
   - 12:00 UTC (19:00 WIB)
4. To trigger a run manually, navigate to the `Actions` tab, select `Top.gg Auto-Vote`, and click `Run workflow`.

---

## Anti-Ban and Timing Mechanics

To prevent account flagging and rate limiting on Top.gg:

1. Randomized Account Intervals: The queue pauses for a random duration between 120 and 180 seconds (2 to 3 minutes) between switching accounts.
2. Multi-Bot Delay: When voting for multiple bot IDs on the same account, the engine pauses for 60 seconds between each bot.
3. Database Skipping: If an account has already voted within the past 12 hours, the voter skips the account in memory without launching a browser window.
4. Video Advertisement Handling: The runner checks for pre-roll video ads on Top.gg and waits up to 45 seconds for completion before searching for the Vote button.
5. Cloudflare Turnstile Resolution: Employs stealth flags and cursor simulation to pass Cloudflare verification challenges automatically.

---

## Discord Notifications

Status updates are formatted as Discord embeds:

- Success: Green embed with bot ID, account username, timestamp, and confirmation message.
- Cooldown Active: Blue informational embed showing remaining cooldown duration and scheduled retry time.
- Failure or Captcha: Red alert embed detailing the failure reason and attaching a full-resolution browser screenshot for diagnostic inspection.

---

## Security and Privacy

- Never commit real cookie JSON files or `.env` files to public version control repositories.
- The `.gitignore` file is preconfigured to exclude `cookies/*.json`, `.env`, and `screenshots/*.png`.
- The database in `data/database.json` records only vote timestamps and bot identifiers; no passwords, tokens, or personal identifiers are written to disk.

---

## License

This project is licensed under the MIT License.
