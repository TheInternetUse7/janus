# Janus Bridge

Bi-directional bridge between Discord and Fluxer.

## Prerequisites

- Node.js 18+
- PostgreSQL 16+ (running locally)
- Redis 7+ (running locally)
- Discord Bot Token
- Fluxer Bot Token
- Docker (optional, for containerized setup)

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/TheInternetUse7/janus.git
cd janus
corepack enable
pnpm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`

### 3. Start PostgreSQL and Redis

### 4. Create Database

### 5. Set Up Prisma

```bash
pnpm prisma:generate
pnpm prisma:push
```

### 6. Start the Bridge

```bash
pnpm dev
```

## Docker Setup

You can run Janus + PostgreSQL + Redis with Docker Compose.

1. Create `.env` from `.env.example` and set at least:
   - `DISCORD_TOKEN`
   - `FLUXER_TOKEN`
2. Start the stack:

```bash
pnpm docker:up
```

3. Stop the stack:

```bash
pnpm docker:down
```

Notes:

- The compose stack sets `DATABASE_URL` and `REDIS_URL` to container service hosts automatically.
- On startup, Janus runs `prisma generate` and `prisma push` before `pnpm start`.

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

1. Start Janus: `pnpm dev`
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
