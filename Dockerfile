FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8080
ENV IMAGES_OUT_DIR=/app/imagens-geradas
ENV OAUTH_DATA_DIR=/app/oauth-data
EXPOSE 8080
CMD ["node", "server.mjs"]
