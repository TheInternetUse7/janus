FROM node:20-alpine

WORKDIR /app

# Install dependencies first for better layer caching
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

# Copy source and build
COPY . .
RUN npm run prisma:generate && npm run build

ENV NODE_ENV=production

CMD ["npm", "start"]
