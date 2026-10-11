# Includes Node.js and the Chromium browser used for JavaScript-only pages.
FROM mcr.microsoft.com/playwright:v1.64.0-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

ENV NODE_ENV=production
CMD ["node", "src/index.js"]
