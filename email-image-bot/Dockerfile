# Includes Node.js and the Chromium browser used for JavaScript-only pages.
FROM mcr.microsoft.com/playwright:v1.64.0-noble

# ffmpeg: saves streamed videos as one file and compresses videos too big for an email.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

ENV NODE_ENV=production
CMD ["node", "src/index.js"]
