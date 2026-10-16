# Backend Dockerfile for NestJS

# ---- local development (docker compose: target: development) ----
FROM node:22-alpine AS development

RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    giflib-dev \
    pixman-dev

WORKDIR /app
COPY package*.json ./
# legacy peer deps to handle @nestjs/typeorm compatibility
RUN npm install --legacy-peer-deps
COPY . .
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

# ---- production build ----
FROM development AS builder
RUN npm run build
RUN npm prune --omit=dev --legacy-peer-deps

# ---- production runtime (default target) ----
FROM node:22-alpine AS production

# Runtime libs for canvas / sharp (no compilers needed).
RUN apk add --no-cache \
    cairo \
    jpeg \
    pango \
    giflib \
    pixman \
    freetype \
    fontconfig \
    ttf-dejavu

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000
COPY --from=builder --chown=node:node /app/package*.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/main"]
