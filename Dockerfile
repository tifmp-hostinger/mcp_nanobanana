# FMP · Nano Banana MCP (remoto) — imagem de produção
FROM node:20-bookworm-slim

WORKDIR /app

# Instala só as dependências primeiro (melhor cache de build)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copia o restante do código
COPY . .

# Porta HTTP (o EasyPanel injeta/mapeia esta porta)
ENV PORT=8080
EXPOSE 8080

# Pasta de saída dos PNGs (pode ser um volume persistente no EasyPanel)
ENV FMP_BG_OUT_DIR=/app/fundos-gerados

CMD ["node", "server.mjs"]
