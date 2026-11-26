FROM node:26-bookworm-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm ci --legacy-peer-deps

COPY . .
RUN npm run typecheck && npm run build

FROM node:26-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4280
ENV CADENCE_DATA_DIR=/var/lib/cadence
ENV CADENCE_SMTP_BIND=0.0.0.0
ENV CADENCE_SMTP_MX_PORT=25
ENV CADENCE_SMTP_SUBMISSION_PORT=587

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server/package.json ./server/package.json
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/dist ./client/dist

RUN mkdir -p /var/lib/cadence && chown -R node:node /var/lib/cadence
VOLUME ["/var/lib/cadence"]

# 4280: Web/API UI | 25: Incoming MX SMTP | 587: Authenticated Submission
EXPOSE 4280 25 587

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4280/api/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/dist/index.js"]
