#!/usr/bin/env bash

# ==============================================================================
# Top.gg Auto-Vote - Interactive VPS Management CLI (All-in-One)
# ==============================================================================

# Ensure script runs from project root directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

PM2_APP_NAME="topgg-vote"
COOKIE_DIR="$SCRIPT_DIR/cookies"
DATA_DIR="$SCRIPT_DIR/data"
ENV_FILE="$SCRIPT_DIR/.env"

# Only Error (Red) and Warning (Yellow) are colored. Everything else is plain text.
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # Reset color

mkdir -p "$COOKIE_DIR"
mkdir -p "$DATA_DIR"

# ------------------------------------------------------------------------------
# Helpers: Status & Process Inspection
# ------------------------------------------------------------------------------
get_bot_status() {
    if ! command -v pm2 >/dev/null 2>&1; then
        echo "NOT_INSTALLED"
        return
    fi
    local status
    status=$(pm2 jlist 2>/dev/null | node -e "
    try {
        const list = JSON.parse(require('fs').readFileSync(0, 'utf-8'));
        const proc = list.find(p => p.name === '$PM2_APP_NAME');
        if (!proc) { console.log('NONE'); }
        else { console.log(proc.pm2_env.status.toUpperCase()); }
    } catch(e) { console.log('ERROR'); }
    " 2>/dev/null)
    echo "${status:-NONE}"
}

is_bot_online() {
    local s
    s=$(get_bot_status)
    [[ "$s" == "ONLINE" ]]
}

launch_pm2_process() {
    pm2 delete "$PM2_APP_NAME" >/dev/null 2>&1
    if command -v xvfb-run >/dev/null 2>&1; then
        echo "Starting bot with PM2 (Virtual Display Xvfb mode)..."
        pm2 start npm --name "$PM2_APP_NAME" --cwd "$SCRIPT_DIR" -- run start:xvfb
    else
        echo -e "${YELLOW}⚠️ Notice: xvfb-run not detected. Starting bot in direct headless mode...${NC}"
        pm2 start npm --name "$PM2_APP_NAME" --cwd "$SCRIPT_DIR" -- start
    fi
    pm2 save >/dev/null 2>&1
}

count_cookie_accounts() {
    find "$COOKIE_DIR" -maxdepth 1 -name "*.json" 2>/dev/null | wc -l
}

get_cookie_username() {
    local file="$1"
    if [[ ! -f "$file" ]]; then
        echo "Unknown"
        return
    fi
    node -e "
    try {
        const fs = require('fs');
        const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
        const arr = Array.isArray(data) ? data : (data.cookies || []);
        const tok = arr.find(c => c.name === '__Secure-authjs.session-token' || c.name === 'authjs.session-token');
        if (tok && tok.value) {
            const parts = tok.value.split('.');
            if (parts.length >= 2) {
                const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
                if (payload.user && (payload.user.name || payload.user.username)) {
                    console.log(payload.user.name || payload.user.username);
                    process.exit(0);
                }
            }
        }
        console.log('Valid Cookie');
    } catch(e) {
        console.log('Invalid JSON');
    }
    " "$file" 2>/dev/null
}

# ------------------------------------------------------------------------------
# UI Banner
# ------------------------------------------------------------------------------
print_banner() {
    clear
    local status
    status=$(get_bot_status)
    local status_display
    if [[ "$status" == "ONLINE" ]]; then
        status_display="ONLINE (24/7 PM2)"
    elif [[ "$status" == "STOPPED" ]]; then
        status_display="${YELLOW}STOPPED${NC}"
    elif [[ "$status" == "NOT_INSTALLED" ]]; then
        status_display="${RED}PM2 Not Installed${NC}"
    else
        status_display="NOT RUNNING"
    fi

    local acc_count
    acc_count=$(count_cookie_accounts)

    echo "=============================================================="
    echo "       TOP.GG AUTO-VOTE - VPS MANAGER (ALL-IN-ONE)            "
    echo "=============================================================="
    echo -e " Bot Status       : $status_display"
    echo " Cookie Accounts  : $acc_count account(s) detected in cookies/"
    echo " Project Directory: $SCRIPT_DIR"
    echo "--------------------------------------------------------------"
}

pause() {
    echo ""
    read -rp "Press [Enter] to return to the main menu..." dummy
}

# ------------------------------------------------------------------------------
# Robust Multi-line JSON Paste Handler (Auto-detects completion on ']')
# ------------------------------------------------------------------------------
read_json_paste() {
    echo "Please PASTE your cookie JSON content below." >&2
    echo "(Paste will auto-complete when the closing ']' is reached, or type 'END' on a new line and press Enter):" >&2
    echo "--------------------------------------------------------------" >&2
    local content=""
    local line=""
    while IFS= read -r line; do
        if [[ "$line" == "END" || "$line" == "end" ]]; then
            break
        fi
        content+="$line"$'\n'

        # Auto-detect if JSON array or object is closed and valid
        local trimmed="${line#"${line%%[![:space:]]*}"}"
        trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
        if [[ "$trimmed" == "]" || "$trimmed" == "}" ]]; then
            local is_valid
            is_valid=$(node -e "
            try {
                const val = JSON.parse(process.argv[1]);
                if (typeof val === 'object' && val !== null) {
                    console.log('VALID');
                } else {
                    console.log('INVALID');
                }
            } catch(e) {
                console.log('INVALID');
            }
            " "$content" 2>/dev/null)
            if [[ "$is_valid" == "VALID" ]]; then
                echo "" >&2
                echo "✓ JSON paste successfully detected and validated!" >&2
                echo "$content"
                return 0
            fi
        fi
    done

    # Validate JSON via Node.js if ended via 'END'
    local is_valid
    is_valid=$(node -e "
    try {
        const val = JSON.parse(process.argv[1]);
        if (typeof val === 'object' && val !== null) {
            console.log('VALID');
        } else {
            console.log('INVALID');
        }
    } catch(e) {
        console.log('INVALID');
    }
    " "$content" 2>/dev/null)

    if [[ "$is_valid" != "VALID" ]]; then
        echo -e "${RED}❌ Error: The pasted text is not valid JSON!${NC}" >&2
        return 1
    fi

    echo "$content"
    return 0
}

# ------------------------------------------------------------------------------
# System Prerequisites Installer (Multi-Distro, Root & Non-Root Adaptive)
# ------------------------------------------------------------------------------
install_system_prerequisites() {
    echo ""
    echo "Checking system dependencies (Node.js, Git, Xvfb, Chrome)..."

    # Setup sudo prefix if running as non-root
    local SUDO=""
    if [[ "$EUID" -ne 0 ]]; then
        if command -v sudo >/dev/null 2>&1; then
            SUDO="sudo"
        else
            echo -e "${YELLOW}⚠️ Notice: Not running as root and 'sudo' is not installed.${NC}"
        fi
    fi

    # Check Node.js and verify version (Node >= 18 is required)
    local need_node=0
    if ! command -v node >/dev/null 2>&1; then
        echo -e "${YELLOW}⚠️ Node.js is not installed.${NC}"
        need_node=1
    else
        local node_major
        node_major=$(node -v 2>/dev/null | sed -E 's/^v//' | cut -d'.' -f1)
        if [[ -n "$node_major" && "$node_major" -lt 18 ]]; then
            echo -e "${YELLOW}⚠️ Node.js version (v$node_major) is too old (requires Node 18+).${NC}"
            need_node=1
        fi
    fi

    # Detect package manager
    local pkg_manager=""
    if command -v apt-get >/dev/null 2>&1; then
        pkg_manager="apt"
    elif command -v dnf >/dev/null 2>&1; then
        pkg_manager="dnf"
    elif command -v yum >/dev/null 2>&1; then
        pkg_manager="yum"
    elif command -v pacman >/dev/null 2>&1; then
        pkg_manager="pacman"
    fi

    if [[ -n "$pkg_manager" ]]; then
        if [[ $need_node -eq 1 ]]; then
            echo "Installing / Updating Node.js 20..."
            if [[ "$pkg_manager" == "apt" ]]; then
                curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash - 2>/dev/null
                $SUDO apt-get install -y nodejs
            elif [[ "$pkg_manager" == "dnf" || "$pkg_manager" == "yum" ]]; then
                curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO bash - 2>/dev/null
                $SUDO $pkg_manager install -y nodejs
            fi
        fi

        # Check Git
        if ! command -v git >/dev/null 2>&1; then
            echo "Installing Git..."
            if [[ "$pkg_manager" == "apt" ]]; then
                $SUDO apt-get install -y git
            elif [[ "$pkg_manager" == "dnf" || "$pkg_manager" == "yum" ]]; then
                $SUDO $pkg_manager install -y git
            fi
        fi

        # Check Xvfb (Virtual Framebuffer)
        if ! command -v xvfb-run >/dev/null 2>&1; then
            echo "Installing Xvfb (Virtual Display)..."
            if [[ "$pkg_manager" == "apt" ]]; then
                $SUDO apt-get update -y 2>/dev/null || true
                $SUDO apt-get install -y xvfb
            elif [[ "$pkg_manager" == "dnf" || "$pkg_manager" == "yum" ]]; then
                $SUDO $pkg_manager install -y xorg-x11-server-Xvfb
            fi
        fi

        # Check Chrome / Chromium and required system graphics libraries
        if ! command -v google-chrome >/dev/null 2>&1 && ! command -v google-chrome-stable >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1; then
            echo "Installing Google Chrome / Chromium & required graphic libraries..."
            if [[ "$pkg_manager" == "apt" ]]; then
                local arch
                arch=$(uname -m 2>/dev/null || echo "x86_64")
                if [[ "$arch" == "x86_64" || "$arch" == "amd64" ]]; then
                    curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/google-chrome-stable.deb 2>/dev/null
                    $SUDO apt-get install -y /tmp/google-chrome-stable.deb 2>/dev/null || true
                    rm -f /tmp/google-chrome-stable.deb
                fi
                $SUDO apt-get install -y fonts-liberation libnss3 libgbm1 libxss1 xdg-utils 2>/dev/null || true
                $SUDO apt-get install -y libasound2t64 2>/dev/null || $SUDO apt-get install -y libasound2 2>/dev/null || true
                $SUDO apt-get install -y libatk-bridge2.0-0t64 2>/dev/null || $SUDO apt-get install -y libatk-bridge2.0-0 2>/dev/null || true
                $SUDO apt-get install -y libgtk-3-0t64 2>/dev/null || $SUDO apt-get install -y libgtk-3-0 2>/dev/null || true
            elif [[ "$pkg_manager" == "dnf" || "$pkg_manager" == "yum" ]]; then
                $SUDO $pkg_manager install -y chromium alsa-lib atk gtk3 nss libXScrnSaver 2>/dev/null || true
            fi
        fi
    else
        echo -e "${YELLOW}⚠️ Unsupported package manager. Please ensure Node.js (>=18), Git, and Xvfb are installed manually.${NC}"
    fi

    # Check PM2
    if ! command -v pm2 >/dev/null 2>&1; then
        echo "Installing PM2 Process Manager globally..."
        $SUDO npm install -g pm2 2>/dev/null || npm install -g pm2 2>/dev/null || true
        if ! command -v pm2 >/dev/null 2>&1; then
            echo -e "${YELLOW}⚠️ Warning: Global PM2 install failed. Local npx pm2 will be used if needed.${NC}"
        fi
    fi
}

# ------------------------------------------------------------------------------
# 1. SETUP & LAUNCH PROJECT (FULL WIZARD)
# ------------------------------------------------------------------------------
menu_full_setup() {
    print_banner
    echo "=== [1] SETUP & LAUNCH PROJECT (FULL WIZARD) ==="
    echo ""

    if is_bot_online; then
        echo -e "${YELLOW}⚠️ WARNING: Bot '$PM2_APP_NAME' is ALREADY RUNNING!${NC}"
        read -rp "Do you want to stop and reconfigure it? (y/N): " confirm_restart
        if [[ ! "$confirm_restart" =~ ^[yY]$ ]]; then
            echo "Operation cancelled."
            pause
            return
        fi
        pm2 stop "$PM2_APP_NAME" >/dev/null 2>&1
    fi

    # 0. Check if git repository files exist in current folder
    if [[ ! -f "$SCRIPT_DIR/package.json" ]]; then
        echo -e "${YELLOW}⚠️ Project repository not detected in this directory ($SCRIPT_DIR).${NC}"
        read -rp "Enter your GitHub Repository URL: " git_repo_url
        if [[ -n "$git_repo_url" ]]; then
            echo "Cloning repository from $git_repo_url..."
            git clone "$git_repo_url" "$SCRIPT_DIR/auto-vote-topgg"
            if [[ -d "$SCRIPT_DIR/auto-vote-topgg" ]]; then
                cd "$SCRIPT_DIR/auto-vote-topgg" || exit 1
                SCRIPT_DIR="$SCRIPT_DIR/auto-vote-topgg"
                COOKIE_DIR="$SCRIPT_DIR/cookies"
                DATA_DIR="$SCRIPT_DIR/data"
                ENV_FILE="$SCRIPT_DIR/.env"
                mkdir -p "$COOKIE_DIR" "$DATA_DIR"
            fi
        fi
    fi

    # 1. Install system prerequisites
    install_system_prerequisites

    # 2. Install npm dependencies
    echo ""
    echo "Installing project npm dependencies..."
    npm install
    if [[ $? -ne 0 ]]; then
        echo -e "${RED}❌ Failed during 'npm install'. Check your VPS internet connection.${NC}"
        pause
        return
    fi

    # 3. Build TypeScript
    echo ""
    echo "Compiling TypeScript (npm run build)..."
    npm run build
    if [[ $? -ne 0 ]]; then
        echo -e "${RED}❌ Compilation failed during 'npm run build'.${NC}"
        pause
        return
    fi
    echo "✓ Compilation completed successfully."

    # 4. Input Account Cookies
    echo ""
    echo "=============================================================="
    echo "           TOP.GG COOKIE ACCOUNTS SETUP                       "
    echo "=============================================================="
    echo "How many Top.gg accounts do you want to configure?"
    read -rp "Number of accounts (e.g. 2): " total_accounts

    if [[ ! "$total_accounts" =~ ^[0-9]+$ ]] || [[ "$total_accounts" -le 0 ]]; then
        total_accounts=1
        echo -e "${YELLOW}Invalid input, using default: 1 account.${NC}"
    fi

    for ((i=1; i<=total_accounts; i++)); do
        local saved=0
        while [[ $saved -eq 0 ]]; do
            echo ""
            echo "--- Input Cookie for Account #$i ---"
            local json_data
            json_data=$(read_json_paste)
            if [[ $? -eq 0 && -n "$json_data" ]]; then
                local filename="account${i}.json"
                echo "$json_data" > "$COOKIE_DIR/$filename"
                local user_detect
                user_detect=$(get_cookie_username "$COOKIE_DIR/$filename")
                echo "✓ Cookie for Account #$i saved to: cookies/$filename"
                echo "  Discord User detected: [ $user_detect ]"
                saved=1
            else
                read -rp "Save failed. Retry for account #$i? (y/N): " retry
                if [[ ! "$retry" =~ ^[yY]$ ]]; then
                    saved=1
                fi
            fi
        done
    done

    # 5. Input Configuration (.env)
    echo ""
    echo "=============================================================="
    echo "               BOT CONFIGURATION (.ENV)                       "
    echo "=============================================================="

    # BOT_IDS
    read -rp "Enter target Top.gg Bot ID(s) (Default: 928711702596423740, comma-separated for multi-bot): " input_bot_ids
    BOT_IDS="${input_bot_ids:-928711702596423740}"

    # DISCORD_WEBHOOK_URL
    read -rp "Enter Discord Webhook URL for reports (Optional, press Enter to skip): " input_webhook
    DISCORD_WEBHOOK_URL="${input_webhook:-}"

    # SEND_ERROR_SCREENSHOTS
    read -rp "Attach screenshot on error? (1 = Yes, 0 = No) [Default: 1]: " input_screens
    SEND_ERROR_SCREENSHOTS="${input_screens:-1}"

    # DEBUG
    read -rp "Enable verbose debug logs? (1 = Yes, 0 = No) [Default: 0]: " input_debug
    DEBUG="${input_debug:-0}"

    # HEADLESS
    read -rp "Run browser in headless mode? (true / false) [Default: true]: " input_headless
    HEADLESS="${input_headless:-true}"

    # ACCOUNT_DELAY_MIN & MAX
    read -rp "Minimum random delay between accounts in seconds [Default: 120]: " input_delay_min
    ACCOUNT_DELAY_MIN="${input_delay_min:-120}"

    read -rp "Maximum random delay between accounts in seconds [Default: 180]: " input_delay_max
    ACCOUNT_DELAY_MAX="${input_delay_max:-180}"

    # BOT_DELAY
    read -rp "Fixed delay between bots on the same account in seconds [Default: 60]: " input_bot_delay
    BOT_DELAY="${input_bot_delay:-60}"

    # PROXY_URL
    read -rp "Proxy URL (Optional, e.g. http://user:pass@host:port, press Enter for direct): " input_proxy
    PROXY_URL="${input_proxy:-}"

    # Write .env file
    cat <<EOF > "$ENV_FILE"
# Target Bot IDs on Top.gg (separate with comma for multiple bots)
BOT_IDS=$BOT_IDS

# Discord Webhook URL for status reports and screenshot alerts (optional)
DISCORD_WEBHOOK_URL=$DISCORD_WEBHOOK_URL

# Send screenshot on error (1 = yes, 0 = no)
SEND_ERROR_SCREENSHOTS=$SEND_ERROR_SCREENSHOTS

# Verbose debug logging (1 = yes, 0 = no)
DEBUG=$DEBUG

# Run browser in headless mode
HEADLESS=$HEADLESS

# Random delay between accounts (in seconds)
ACCOUNT_DELAY_MIN=$ACCOUNT_DELAY_MIN
ACCOUNT_DELAY_MAX=$ACCOUNT_DELAY_MAX

# Fixed delay between different bots on the same account (in seconds)
BOT_DELAY=$BOT_DELAY

# Optional HTTP/HTTPS/SOCKS proxy
PROXY_URL=$PROXY_URL
EOF

    echo ""
    echo "✓ .env file successfully created and saved!"

    # 6. Launch with PM2
    echo ""
    launch_pm2_process

    echo ""
    echo "=============================================================="
    echo "🎉 SUCCESS! Top.gg Auto-Vote is now running 24/7 in PM2!     "
    echo "=============================================================="
    echo "Quick commands:"
    echo " • View Logs   : pm2 logs $PM2_APP_NAME"
    echo " • Check Status: pm2 status"
    echo ""
    read -rp "Would you like to view bot logs right now? (Y/n): " view_now
    if [[ "$view_now" =~ ^[nN]$ ]]; then
        return
    fi
    pm2 logs "$PM2_APP_NAME" --lines 40
}

# ------------------------------------------------------------------------------
# 2. MANAGE COOKIE ACCOUNTS (ADD / EDIT / DELETE)
# ------------------------------------------------------------------------------
menu_manage_cookies() {
    while true; do
        print_banner
        echo "=== [2] MANAGE COOKIE ACCOUNTS ==="
        echo ""

        # List existing cookies
        local files=()
        while IFS= read -r -d '' f; do
            files+=("$f")
        done < <(find "$COOKIE_DIR" -maxdepth 1 -name "*.json" -print0 | sort -z)

        if [[ ${#files[@]} -eq 0 ]]; then
            echo -e "${YELLOW}No cookie files found in cookies/ directory.${NC}"
            echo ""
        else
            echo "Available Accounts:"
            local idx=1
            for f in "${files[@]}"; do
                local fname
                fname=$(basename "$f")
                local user
                user=$(get_cookie_username "$f")
                local mtime
                mtime=$(date -r "$f" "+%Y-%m-%d %H:%M" 2>/dev/null || echo "-")
                echo "  [$idx] $fname -> Discord: $user (Modified: $mtime)"
                ((idx++))
            done
            echo ""
        fi

        echo "Actions:"
        echo "  [1] Add New Account"
        echo "  [2] Edit / Replace Existing Account Cookie"
        echo "  [3] Delete Account Cookie"
        echo "  [0] Back to Main Menu"
        echo ""
        read -rp "Select option [0-3]: " sub_opt

        case "$sub_opt" in
            1)
                echo ""
                echo "--- Add New Account Cookie ---"
                local next_num=1
                while [[ -f "$COOKIE_DIR/account${next_num}.json" ]]; do
                    ((next_num++))
                done
                read -rp "Cookie file name (Default: account${next_num}.json): " custom_name
                local target_file="${custom_name:-account${next_num}.json}"
                if [[ "$target_file" != *.json ]]; then
                    target_file="${target_file}.json"
                fi

                local json_data
                json_data=$(read_json_paste)
                if [[ $? -eq 0 && -n "$json_data" ]]; then
                    echo "$json_data" > "$COOKIE_DIR/$target_file"
                    local user_detect
                    user_detect=$(get_cookie_username "$COOKIE_DIR/$target_file")
                    echo ""
                    echo "✓ Successfully added account: $target_file [ $user_detect ]"
                    if is_bot_online; then
                        echo "Restarting bot to automatically load the new account..."
                        pm2 restart "$PM2_APP_NAME" >/dev/null 2>&1
                        echo "✓ Bot successfully restarted."
                    fi
                fi
                pause
                ;;
            2)
                if [[ ${#files[@]} -eq 0 ]]; then
                    echo -e "${RED}❌ No cookie files available to edit!${NC}"
                    pause
                    continue
                fi
                echo ""
                echo "--- Edit / Replace Account Cookie ---"
                read -rp "Select account number to edit (1-${#files[@]}): " edit_idx
                if [[ ! "$edit_idx" =~ ^[0-9]+$ ]] || [[ "$edit_idx" -lt 1 ]] || [[ "$edit_idx" -gt ${#files[@]} ]]; then
                    echo -e "${RED}❌ Invalid account number!${NC}"
                    pause
                    continue
                fi
                local target_file="${files[$((edit_idx-1))]}"
                local fname
                fname=$(basename "$target_file")
                echo "Editing file: $fname"

                local json_data
                json_data=$(read_json_paste)
                if [[ $? -eq 0 && -n "$json_data" ]]; then
                    echo "$json_data" > "$target_file"
                    local user_detect
                    user_detect=$(get_cookie_username "$target_file")
                    echo ""
                    echo "✓ Successfully updated cookie: $fname [ $user_detect ]"
                    if is_bot_online; then
                        echo "Restarting bot to apply the updated cookie immediately..."
                        pm2 restart "$PM2_APP_NAME" >/dev/null 2>&1
                        echo "✓ Bot successfully restarted with updated cookie."
                    fi
                fi
                pause
                ;;
            3)
                if [[ ${#files[@]} -eq 0 ]]; then
                    echo -e "${RED}❌ No cookie files available to delete!${NC}"
                    pause
                    continue
                fi
                echo ""
                echo "--- Delete Account Cookie ---"
                read -rp "Select account number to delete (1-${#files[@]}): " del_idx
                if [[ ! "$del_idx" =~ ^[0-9]+$ ]] || [[ "$del_idx" -lt 1 ]] || [[ "$del_idx" -gt ${#files[@]} ]]; then
                    echo -e "${RED}❌ Invalid account number!${NC}"
                    pause
                    continue
                fi
                local target_file="${files[$((del_idx-1))]}"
                local fname
                fname=$(basename "$target_file")
                read -rp "Are you sure you want to delete '$fname'? (y/N): " confirm_del
                if [[ "$confirm_del" =~ ^[yY]$ ]]; then
                    rm -f "$target_file"
                    echo "✓ File $fname deleted."
                    if is_bot_online; then
                        echo "Restarting bot..."
                        pm2 restart "$PM2_APP_NAME" >/dev/null 2>&1
                    fi
                else
                    echo "Deletion cancelled."
                fi
                pause
                ;;
            0)
                break
                ;;
            *)
                echo -e "${RED}❌ Invalid option!${NC}"
                sleep 1
                ;;
        esac
    done
}

# ------------------------------------------------------------------------------
# 3. EDIT CONFIGURATION (.ENV)
# ------------------------------------------------------------------------------
menu_edit_env() {
    print_banner
    echo "=== [3] EDIT CONFIGURATION (.ENV) ==="
    echo ""

    if [[ ! -f "$ENV_FILE" ]]; then
        echo -e "${YELLOW}⚠️ File .env not found. Creating from .env.example...${NC}"
        cp "$SCRIPT_DIR/.env.example" "$ENV_FILE" 2>/dev/null || touch "$ENV_FILE"
    fi

    # Read current values
    get_env_val() {
        grep "^$1=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2-
    }

    local cur_bots=$(get_env_val "BOT_IDS")
    local cur_webhook=$(get_env_val "DISCORD_WEBHOOK_URL")
    local cur_screens=$(get_env_val "SEND_ERROR_SCREENSHOTS")
    local cur_debug=$(get_env_val "DEBUG")
    local cur_headless=$(get_env_val "HEADLESS")
    local cur_dmin=$(get_env_val "ACCOUNT_DELAY_MIN")
    local cur_dmax=$(get_env_val "ACCOUNT_DELAY_MAX")
    local cur_bdelay=$(get_env_val "BOT_DELAY")
    local cur_proxy=$(get_env_val "PROXY_URL")

    echo "Current Configuration:"
    echo " 1) BOT_IDS                : ${cur_bots:-Not configured}"
    echo " 2) DISCORD_WEBHOOK_URL    : ${cur_webhook:-None}"
    echo " 3) SEND_ERROR_SCREENSHOTS : ${cur_screens:-1}"
    echo " 4) DEBUG                  : ${cur_debug:-0}"
    echo " 5) HEADLESS               : ${cur_headless:-true}"
    echo " 6) ACCOUNT_DELAY_MIN/MAX  : ${cur_dmin:-120}s - ${cur_dmax:-180}s"
    echo " 7) BOT_DELAY              : ${cur_bdelay:-60}s"
    echo " 8) PROXY_URL              : ${cur_proxy:-None}"
    echo ""
    echo "Choose editing method:"
    echo " [1] Interactive Questionnaire (Easy)"
    echo " [2] Open directly with 'nano' editor"
    echo " [0] Cancel / Back"
    read -rp "Select [0-2]: " edit_mode

    if [[ "$edit_mode" == "1" ]]; then
        read -rp "Target Bot ID(s) [Current: ${cur_bots:-928711702596423740}]: " n_bots
        BOT_IDS="${n_bots:-${cur_bots:-928711702596423740}}"

        read -rp "Discord Webhook URL [Current: ${cur_webhook:-empty}]: " n_webhook
        DISCORD_WEBHOOK_URL="${n_webhook:-$cur_webhook}"

        read -rp "Send screenshot on failure? (1/0) [Current: ${cur_screens:-1}]: " n_screens
        SEND_ERROR_SCREENSHOTS="${n_screens:-${cur_screens:-1}}"

        read -rp "Debug logging mode? (1/0) [Current: ${cur_debug:-0}]: " n_debug
        DEBUG="${n_debug:-${cur_debug:-0}}"

        read -rp "Headless mode? (true/false) [Current: ${cur_headless:-true}]: " n_headless
        HEADLESS="${n_headless:-${cur_headless:-true}}"

        read -rp "Minimum account delay in seconds [Current: ${cur_dmin:-120}]: " n_dmin
        ACCOUNT_DELAY_MIN="${n_dmin:-${cur_dmin:-120}}"

        read -rp "Maximum account delay in seconds [Current: ${cur_dmax:-180}]: " n_dmax
        ACCOUNT_DELAY_MAX="${n_dmax:-${cur_dmax:-180}}"

        read -rp "Inter-bot delay in seconds [Current: ${cur_bdelay:-60}]: " n_bdelay
        BOT_DELAY="${n_bdelay:-${cur_bdelay:-60}}"

        read -rp "Proxy URL [Current: ${cur_proxy:-empty}]: " n_proxy
        PROXY_URL="${n_proxy:-$cur_proxy}"

        cat <<EOF > "$ENV_FILE"
BOT_IDS=$BOT_IDS
DISCORD_WEBHOOK_URL=$DISCORD_WEBHOOK_URL
SEND_ERROR_SCREENSHOTS=$SEND_ERROR_SCREENSHOTS
DEBUG=$DEBUG
HEADLESS=$HEADLESS
ACCOUNT_DELAY_MIN=$ACCOUNT_DELAY_MIN
ACCOUNT_DELAY_MAX=$ACCOUNT_DELAY_MAX
BOT_DELAY=$BOT_DELAY
PROXY_URL=$PROXY_URL
EOF
        echo ""
        echo "✓ .env configuration updated successfully!"

    elif [[ "$edit_mode" == "2" ]]; then
        nano "$ENV_FILE"
        echo ""
        echo "✓ .env file saved."
    else
        echo "Cancelled."
        pause
        return
    fi

    if is_bot_online; then
        echo "Restarting bot to apply new configuration..."
        pm2 restart "$PM2_APP_NAME" >/dev/null 2>&1
        echo "✓ Bot successfully restarted."
    fi
    pause
}

# ------------------------------------------------------------------------------
# 4. START BOT (WITH DUPLICATION CHECK)
# ------------------------------------------------------------------------------
menu_start_bot() {
    print_banner
    echo "=== [4] START BOT ==="
    echo ""

    # Duplication check
    if is_bot_online; then
        echo -e "${YELLOW}⚠️ WARNING: Bot '$PM2_APP_NAME' is ALREADY RUNNING (Status: ONLINE)!${NC}"
        echo -e "${RED}⛔ Duplicate startup is blocked to prevent concurrent voting conflicts.${NC}"
        echo ""
        echo "Use option [7] to view live Logs or [6] to Restart."
        pause
        return
    fi

    # Check cookies
    local acc_count
    acc_count=$(count_cookie_accounts)
    if [[ $acc_count -eq 0 ]]; then
        echo -e "${RED}❌ No cookie accounts found in cookies/ directory!${NC}"
        echo "Please use menu [2] Manage Cookie Accounts to add account cookies first."
        pause
        return
    fi

    # Check build
    if [[ ! -f "$SCRIPT_DIR/dist/index.js" ]]; then
        echo -e "${YELLOW}Project is not built yet. Running 'npm run build'...${NC}"
        npm run build
        if [[ $? -ne 0 ]]; then
            echo -e "${RED}❌ Build failed! Please inspect the errors above.${NC}"
            pause
            return
        fi
    fi

    launch_pm2_process

    echo ""
    echo "✓ Bot '$PM2_APP_NAME' successfully started in the background!"
    echo ""
    read -rp "View logs now? (Y/n): " ans
    if [[ ! "$ans" =~ ^[nN]$ ]]; then
        pm2 logs "$PM2_APP_NAME" --lines 30
    fi
}

# ------------------------------------------------------------------------------
# 5. STOP BOT
# ------------------------------------------------------------------------------
menu_stop_bot() {
    print_banner
    echo "=== [5] STOP BOT ==="
    echo ""

    if ! is_bot_online; then
        echo -e "${YELLOW}Bot '$PM2_APP_NAME' is not currently running.${NC}"
        pause
        return
    fi

    echo "Stopping bot '$PM2_APP_NAME'..."
    pm2 stop "$PM2_APP_NAME"
    echo ""
    echo "✓ Bot successfully stopped."
    pause
}

# ------------------------------------------------------------------------------
# 6. RESTART BOT
# ------------------------------------------------------------------------------
menu_restart_bot() {
    print_banner
    echo "=== [6] RESTART BOT ==="
    echo ""

    echo "Compiling TypeScript (npm run build)..."
    npm run build

    launch_pm2_process
    echo ""
    echo "✓ Bot successfully restarted."
    echo ""
    read -rp "View logs now? (Y/n): " ans
    if [[ ! "$ans" =~ ^[nN]$ ]]; then
        pm2 logs "$PM2_APP_NAME" --lines 30
    fi
}

# ------------------------------------------------------------------------------
# 7. VIEW REAL-TIME LOGS
# ------------------------------------------------------------------------------
menu_view_logs() {
    print_banner
    echo "=== [7] VIEW REAL-TIME LOGS ==="
    echo ""
    echo "Streaming live logs from PM2."
    echo "Press [Ctrl + C] at any time to return to the menu."
    echo ""
    sleep 1
    pm2 logs "$PM2_APP_NAME" --lines 50
}

# ------------------------------------------------------------------------------
# 8. SYSTEM & BOT STATUS
# ------------------------------------------------------------------------------
menu_status_info() {
    print_banner
    echo "=== [8] SYSTEM & BOT STATUS ==="
    echo ""

    echo "PM2 Process Details:"
    pm2 show "$PM2_APP_NAME" 2>/dev/null || pm2 list

    echo ""
    echo "Cooldown Database ($DATA_DIR/database.json):"
    if [[ -f "$DATA_DIR/database.json" ]]; then
        node -e "
        try {
            const db = JSON.parse(require('fs').readFileSync('$DATA_DIR/database.json', 'utf8'));
            const keys = Object.keys(db);
            console.log('Total cooldown records stored:', keys.length);
            for (const k of keys.slice(0, 5)) {
                const item = db[k];
                const last = new Date(item.lastVotedAt);
                const next = new Date(item.nextEligibleAt);
                const now = new Date();
                const rem = Math.max(0, Math.round((next - now)/60000));
                console.log(' - ' + k + ' | Last vote: ' + last.toLocaleTimeString() + ' | Remaining cooldown: ' + rem + ' mins');
            }
        } catch(e) { console.log('Database empty or invalid.'); }
        " 2>/dev/null
    else
        echo "Database file not created yet (will be created automatically on the first vote)."
    fi

    echo ""
    echo "VPS Resource Usage:"
    free -h 2>/dev/null | awk 'NR==1{printf "  RAM Total: %s\n", $2} NR==2{printf "  RAM Used: %s (Free: %s)\n", $3, $4}' || true
    df -h / 2>/dev/null | awk 'NR==2{printf "  Disk Used: %s of %s (%s)\n", $3, $2, $5}' || true

    pause
}

# ------------------------------------------------------------------------------
# 9. UPDATE PROJECT FROM GITHUB (GIT PULL & REBUILD)
# ------------------------------------------------------------------------------
menu_update_repo() {
    print_banner
    echo "=== [9] UPDATE PROJECT FROM GITHUB ==="
    echo ""

    if [[ ! -d "$SCRIPT_DIR/.git" ]]; then
        echo -e "${YELLOW}⚠️ This directory is not a git repository. Cannot run git pull.${NC}"
        pause
        return
    fi

    echo "Fetching latest updates from GitHub (git pull)..."
    # Automatically stash or checkout local run.sh changes so git pull succeeds seamlessly
    git checkout run.sh >/dev/null 2>&1 || git stash >/dev/null 2>&1
    git pull
    if [[ $? -ne 0 ]]; then
        echo -e "${YELLOW}⚠️ Standard git pull encountered a conflict. Resetting to remote origin...${NC}"
        local branch_name
        branch_name=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
        git fetch origin "$branch_name" >/dev/null 2>&1
        git reset --hard "origin/$branch_name"
    fi

    echo ""
    echo "Updating dependencies (npm install)..."
    npm install

    echo ""
    echo "Recompiling TypeScript (npm run build)..."
    npm run build
    if [[ $? -ne 0 ]]; then
        echo -e "${RED}❌ TypeScript compilation failed!${NC}"
        pause
        return
    fi

    echo ""
    echo "✓ Project updated successfully."

    if is_bot_online; then
        echo "Restarting bot to apply new code immediately..."
        pm2 restart "$PM2_APP_NAME" >/dev/null 2>&1
        echo "✓ Bot successfully restarted with latest code!"
    fi
    pause
}

# ------------------------------------------------------------------------------
# 10. REMOVE BOT FROM PM2
# ------------------------------------------------------------------------------
menu_delete_bot() {
    print_banner
    echo "=== [10] REMOVE BOT FROM PM2 ==="
    echo ""
    echo -e "${YELLOW}Notice: This will stop and remove '$PM2_APP_NAME' from the PM2 process list.${NC}"
    echo "(Your .env configuration, cookies, and database files will NOT be deleted)."
    echo ""
    read -rp "Are you sure you want to remove it? (y/N): " confirm_del

    if [[ "$confirm_del" =~ ^[yY]$ ]]; then
        pm2 stop "$PM2_APP_NAME" >/dev/null 2>&1
        pm2 delete "$PM2_APP_NAME" >/dev/null 2>&1
        pm2 save >/dev/null 2>&1
        echo ""
        echo "✓ Bot '$PM2_APP_NAME' successfully removed from PM2."
    else
        echo ""
        echo "Removal cancelled."
    fi
    pause
}

# ------------------------------------------------------------------------------
# MAIN LOOP
# ------------------------------------------------------------------------------
while true; do
    print_banner
    echo "MAIN MENU:"
    echo "  [1]  Setup & Launch Project (Full Wizard)"
    echo "  [2]  Manage Cookie Accounts (Add / Edit / Delete)"
    echo "  [3]  Edit Configuration (.env) (Bot IDs, Webhook, Delays, Proxy)"
    echo "  [4]  Start Bot (Prevents duplicate instances)"
    echo "  [5]  Stop Bot"
    echo "  [6]  Restart Bot"
    echo "  [7]  View Real-Time Logs (PM2 Logs)"
    echo "  [8]  Check System & Bot Status"
    echo "  [9]  Update Project from GitHub (Git Pull & Rebuild)"
    echo "  [10] Remove Bot from PM2"
    echo "  [0]  Exit"
    echo ""
    read -rp "Select an option [0-10]: " main_choice

    case "$main_choice" in
        1) menu_full_setup ;;
        2) menu_manage_cookies ;;
        3) menu_edit_env ;;
        4) menu_start_bot ;;
        5) menu_stop_bot ;;
        6) menu_restart_bot ;;
        7) menu_view_logs ;;
        8) menu_status_info ;;
        9) menu_update_repo ;;
        10) menu_delete_bot ;;
        0)
            echo ""
            echo "Goodbye! Any bot running in PM2 will continue running 24/7 in the background."
            echo ""
            exit 0
            ;;
        *)
            echo ""
            echo -e "${RED}❌ Invalid option! Please enter a number from 0 to 10.${NC}"
            sleep 1.5
            ;;
    esac
done
