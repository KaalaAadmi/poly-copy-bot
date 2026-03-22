#!/bin/bash
# ============================================================
# Poly-Bot VPS Setup Script
# Tested on Ubuntu 24.04 (Hetzner)
# ============================================================

set -e

echo "========================================="
echo "  Poly-Bot — VPS Setup"
echo "========================================="

# ── 1. Install Node.js 20 LTS ──
echo ""
echo "▶ Installing Node.js 20 LTS..."
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v)
    echo "  Node.js already installed: $NODE_VERSION"
else
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
    echo "  Node.js $(node -v) installed"
fi

# ── 2. Install pm2 (process manager) ──
echo ""
echo "▶ Installing pm2..."
if command -v pm2 &> /dev/null; then
    echo "  pm2 already installed"
else
    sudo npm install -g pm2
    echo "  pm2 installed"
fi

# ── 3. Install git (if missing) ──
echo ""
echo "▶ Checking git..."
if command -v git &> /dev/null; then
    echo "  git already installed"
else
    sudo apt-get install -y git
    echo "  git installed"
fi

# ── 4. Clone or update repo ──
echo ""
REPO_DIR="$HOME/projects/poly-copy-bot"

if [ -d "$REPO_DIR" ]; then
    echo "▶ Repo directory exists — pulling latest..."
    cd "$REPO_DIR"
    git pull
else
    echo "▶ Cloning repository..."
    read -p "  Enter your git repo URL (e.g. https://github.com/user/repo.git): " REPO_URL
    git clone "$REPO_URL" "$REPO_DIR"
    cd "$REPO_DIR"
fi

# ── 5. Install dependencies ──
echo ""
echo "▶ Installing npm dependencies..."
npm install

# ── 6. Build ──
echo ""
echo "▶ Building TypeScript..."
npm run build

# ── 7. Create .env if missing ──
echo ""
if [ ! -f "$REPO_DIR/.env" ]; then
    if [ -f "$REPO_DIR/.env.example" ]; then
        echo "▶ Creating .env from .env.example..."
        cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
        echo "  ⚠️  IMPORTANT: Edit .env with your real credentials:"
        echo "     nano $REPO_DIR/.env"
    else
        echo "  ⚠️  No .env or .env.example found."
        echo "     You must create $REPO_DIR/.env before starting the bot."
    fi
else
    echo "▶ .env already exists — skipping"
fi

# ── 8. Start with pm2 ──
echo ""
echo "▶ Starting bot with pm2..."

# Stop existing instance if running
pm2 delete poly-bot 2>/dev/null || true

pm2 start dist/index.js --name poly-bot
pm2 save

# ── 9. Setup pm2 startup (survive reboots) ──
echo ""
echo "▶ Setting up pm2 startup..."
pm2 startup systemd -u "$USER" --hp "$HOME" | tail -1 | bash 2>/dev/null || true
pm2 save

echo ""
echo "========================================="
echo "  ✅ Poly-Bot is running!"
echo "========================================="
echo ""
echo "  Useful commands:"
echo "    pm2 logs poly-bot       # view live logs"
echo "    pm2 status              # check status"
echo "    pm2 restart poly-bot    # restart bot"
echo "    pm2 stop poly-bot       # stop bot"
echo ""
echo "  To update later:"
echo "    cd ~/poly-bot && git pull && npm install && npm run build && pm2 restart poly-bot"
echo ""
echo "  ⚠️  Don't forget to edit .env if you haven't already:"
echo "    nano ~/poly-bot/.env"
echo ""
