# services/worker/Dockerfile: every scheduled job, in one long-running process. No port.
FROM node:22-slim
WORKDIR /repo
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY services/api/package.json services/api/
COPY services/worker/package.json services/worker/
COPY web/package.json web/
RUN npm ci --omit=dev && npm cache clean --force
COPY packages/core packages/core
COPY services/worker services/worker
COPY db db
COPY data/geocode-overrides.csv data/geocode-overrides.csv
CMD ["node", "services/worker/index.js"]
