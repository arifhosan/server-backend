# Built in-house rather than using canardconfit/puppeteer-docker, which is
# pinned to Node 20.18.1. NestJS 12 is ESM-only and needs require(esm), which
# landed in Node 20.19 - that image is one patch short of being able to boot
# this app at all. It was also last built in Dec 2024 and is arm64-only.
#
# Chrome for Testing publishes no linux-arm64 build, which is why the upstream
# image fetched Chromium from Playwright's CDN. Debian's own chromium package
# covers arm64 and amd64 and keeps getting security updates, so we use that.

# ---- build stage -------------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app

# Puppeteer must not download a browser here; the runtime stage supplies it.
# Both names are set: puppeteer >= 20 reads PUPPETEER_SKIP_DOWNLOAD, older
# versions read PUPPETEER_SKIP_CHROMIUM_DOWNLOAD.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Manifests first so the dependency layer is cached until they actually change.
COPY package*.json ./
# `npm ci` installs exactly what the lockfile pins, unlike `npm install`.
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime stage -----------------------------------------------------------
FROM node:24-slim AS runtime

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CHROME_PATH=/usr/bin/chromium

# chromium pulls in most of its own libraries; the fonts are needed for the
# scraped pages to render text at all.
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        chromium \
        ca-certificates \
        dumb-init \
        fonts-freefont-ttf \
        fonts-ipafont-gothic \
        fonts-liberation \
        fonts-wqy-zenhei \
    && rm -rf /var/lib/apt/lists/*

# Run as a non-root user. The upstream image switched to root to install and
# never switched back for the app itself.
RUN groupadd -r pptruser && useradd -rm -g pptruser -G audio,video pptruser
USER pptruser
WORKDIR /home/pptruser/app

COPY --chown=pptruser:pptruser --from=build /app/node_modules ./node_modules
COPY --chown=pptruser:pptruser --from=build /app/dist ./dist
COPY --chown=pptruser:pptruser --from=build /app/package.json ./package.json

EXPOSE 3000
# dumb-init reaps the zombie processes Chromium leaves behind.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main"]
