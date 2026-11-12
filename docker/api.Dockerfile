FROM node:22-alpine AS base
WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY apps/api/package.json ./apps/api/

RUN npm install

COPY packages/shared-types ./packages/shared-types
COPY apps/api ./apps/api
COPY db ./db

RUN npm run build --workspace=@ft360/shared-types && npm run build --workspace=@ft360/api

EXPOSE 4000
CMD ["npm", "run", "start:prod", "--workspace=@ft360/api"]

