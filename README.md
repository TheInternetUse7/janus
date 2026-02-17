# Janus Bridge

Bi-directional bridge between Discord and Fluxer.

## Prerequisites

- Node.js 18+
- PostgreSQL 16+ (running locally)
- Redis 7+ (running locally)
- Discord Bot Token
- Fluxer Bot Token

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/TheInternetUse7/janus.git
cd janus
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
DISCORD_TOKEN=your_discord_bot_token
FLUXER_TOKEN=your_fluxer_bot_token
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/janus
REDIS_URL=redis://localhost:6379
```

### 3. Start PostgreSQL and Redis

**Option A: Install locally**

- [PostgreSQL](https://www.postgresql.org/download/)
- [Redis](https://redis.io/download)

**Option B: Use package managers**

macOS:

```bash
brew install postgresql@16 redis
brew services start postgresql@16
brew services start redis
```

Linux (Ubuntu):

```bash
sudo apt install postgresql redis-server
sudo systemctl start postgresql
sudo systemctl start redis-server
```

Windows:

- Use [PostgreSQL installer](https://www.postgresql.org/download/windows/)
- Use [Memurai](https://www.memurai.com/) or [Redis for Windows](https://github.com/tporadowski/redis/releases)

### 4. Create Database

```bash
# Connect to PostgreSQL
psql -U postgres

# Create database
CREATE DATABASE janus;
\q
```

### 5. Set Up Prisma

```bash
npm run prisma:generate
npm run prisma:push
```

### 6. Start the Bridge

```bash
npm run dev
```

## Getting Tokens

### Discord Bot Token

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create/select application
3. Go to "Bot" section
4. Copy token (click "Reset Token" if needed)
5. Enable "Message Content Intent" in "Privileged Gateway Intents"

### Fluxer Bot Token

1. Go to Fluxer app → User Settings → Applications
2. Create application
3. Copy bot token
4. Generate OAuth2 URL with "Bot" scope and authorize to your server

### Getting Channel IDs

**Discord:**

1. User Settings → Advanced → Developer Mode: ON
2. Right-click channel → "Copy Channel ID"

**Fluxer:**

1. User Settings → Advanced → Developer Mode: ON
2. Right-click channel → "Copy Channel ID"

## Testing

1. Start Janus: `npm run dev`
2. Join both Discord and Fluxer servers with the bot
3. Send a message in the Discord channel
4. It should appear in the linked Fluxer channel (and vice versa)

## Environment Variables

| Variable        | Required | Default | Description           |
| --------------- | -------- | ------- | --------------------- |
| `DISCORD_TOKEN` | Yes      | -       | Discord Bot Token     |
| `FLUXER_TOKEN`  | Yes      | -       | Fluxer Bot Token      |
| `DATABASE_URL`  | Yes      | -       | PostgreSQL connection |
| `REDIS_URL`     | Yes      | -       | Redis connection      |
| `LOG_LEVEL`     | No       | `info`  | Logging level         |
