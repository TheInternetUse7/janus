FROM node:20-alpine

WORKDIR /app

# Install dependencies first for better layer caching
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY . .
RUN pnpm prisma:generate && pnpm build

ENV NODE_ENV=production

CMD ["pnpm", "start"]
