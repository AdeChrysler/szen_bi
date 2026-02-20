FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY --from=builder /app/dist/ ./dist/

# Config needed at startup
COPY config/ ./config/

# Connect wizard — pre-built by `npm run build:connect` before docker build
COPY public/ ./public/

EXPOSE 4000

CMD ["node", "dist/index.js"]
