ARG BUILD_FROM
FROM node:24-alpine AS build
WORKDIR /build
COPY package*.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci
COPY . .
RUN npm run build

FROM ${BUILD_FROM}
RUN apk add --no-cache nodejs chromium
WORKDIR /app
COPY --from=build /build/package*.json ./
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/apps/server/dist ./apps/server/dist
COPY --from=build /build/apps/server/package.json ./apps/server/package.json
COPY --from=build /build/apps/web/dist ./apps/web/dist
COPY --from=build /build/packages/shared/dist ./packages/shared/dist
COPY --from=build /build/packages/shared/package.json ./packages/shared/package.json
COPY run.sh /run.sh
RUN chmod +x /run.sh
ENV CHROMIUM_PATH=/usr/bin/chromium-browser
CMD ["/run.sh"]
