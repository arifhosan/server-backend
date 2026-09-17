FROM canardconfit/puppeteer-docker:latest
USER root
WORKDIR /home/pptruser/app

# Copy manifests first so `npm ci` is cached until dependencies actually change.
COPY package*.json ./
# `npm ci` installs exactly what package-lock.json pins, unlike `npm install`
# which can silently resolve different versions at build time.
RUN npm ci

COPY . .
RUN npm run build

# Drop devDependencies now that the build is done.
RUN npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/main"]
