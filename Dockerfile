FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
# 端口交给平台通过 PORT 注入（CloudBase 云托管、Render 等都是这么做的），
# 这里的 ENV 只是本地 docker run 时的默认值。
ENV PORT=3000

COPY package.json ./
COPY server.mjs ./
COPY public ./public

EXPOSE 3000

# 健康检查跟随实际端口，避免平台把 PORT 换成 80/8080 之后一直报 unhealthy。
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health" >/dev/null || exit 1

CMD ["node", "server.mjs"]
