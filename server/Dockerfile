# syntax=docker/dockerfile:1.7
FROM node:20-alpine

WORKDIR /app

# Install deps separately for better layer caching
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App source
COPY server.js ./
COPY lib ./lib
COPY routes ./routes

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
USER nodejs

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Health check: Node.js inline HTTP check (no wget needed, works on any Alpine)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]