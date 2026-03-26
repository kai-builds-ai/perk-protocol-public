FROM node:22-slim

WORKDIR /app

COPY package*.json ./
COPY sdk-dist/ ./sdk-dist/

RUN npm install --production

COPY tsconfig.json ./
COPY *.ts ./
COPY loops/ ./loops/

RUN npx tsc

CMD ["node", "dist/cranker.js"]
