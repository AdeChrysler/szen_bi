FROM alpine/git AS cloner
WORKDIR /repo
RUN git clone https://github.com/AdeChrysler/szen_bi.git .

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=cloner /repo/packages/orchestrator/package.json ./
RUN npm install --include=dev
COPY --from=cloner /repo/packages/orchestrator/tsconfig.json ./
COPY --from=cloner /repo/packages/orchestrator/src/ ./src/
RUN ./node_modules/.bin/tsc

FROM node:22-slim
WORKDIR /app
COPY --from=cloner /repo/packages/orchestrator/package.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist/ ./dist/
COPY --from=cloner /repo/packages/orchestrator/config ./config
COPY --from=cloner /repo/packages/orchestrator/public ./public

EXPOSE 80
CMD ["node", "dist/index.js"]
