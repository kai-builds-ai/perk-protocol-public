FROM node:22-slim

WORKDIR /app

# Copy and build SDK first (cranker depends on it)
COPY sdk/package.json sdk/package-lock.json ./sdk/
RUN cd sdk && npm ci

COPY sdk/ ./sdk/
RUN cd sdk && npm run build

# Copy and build cranker
COPY cranker/package.json cranker/package-lock.json ./cranker/
RUN cd cranker && npm ci

COPY cranker/ ./cranker/
RUN cd cranker && npm run build

WORKDIR /app/cranker
CMD ["node", "dist/cranker.js"]
