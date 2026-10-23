# services/api/Dockerfile: builds the frontend, then runs Fastify, which serves both /api and web/dist.
FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY services/api/package.json services/api/
COPY services/worker/package.json services/worker/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build --workspace web        # vite build -> web/dist

FROM node:22-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY services/api/package.json services/api/
COPY services/worker/package.json services/worker/
COPY web/package.json web/
RUN npm ci --omit=dev && npm cache clean --force
COPY packages/core packages/core
COPY services/api services/api
COPY db db
COPY --from=build /repo/web/dist web/dist
EXPOSE 8080
CMD ["node", "services/api/server.js"]
