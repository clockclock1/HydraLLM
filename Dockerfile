FROM node:24-alpine AS ui-build

WORKDIR /app
COPY ui/package*.json ./ui/
RUN npm --prefix ui ci
COPY ui ./ui
RUN npm --prefix ui run build

FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787

COPY server.js package.json README.md ./
COPY --from=ui-build /app/ui/dist/index.html ./public/index.html

EXPOSE 8787
CMD ["node", "server.js"]
