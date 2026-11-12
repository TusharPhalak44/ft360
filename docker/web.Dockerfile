FROM node:22-alpine AS base
WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY apps/web/package.json ./apps/web/

RUN npm install

COPY packages/shared-types ./packages/shared-types
COPY apps/web ./apps/web

RUN npm run build --workspace=@ft360/shared-types && npm run build --workspace=@ft360/web

EXPOSE 3000
CMD ["npm", "run", "start", "--workspace=@ft360/web"]

