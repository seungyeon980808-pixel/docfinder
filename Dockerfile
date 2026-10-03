FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY scripts ./scripts
COPY js ./js
COPY vendor ./vendor
COPY styles ./styles
COPY config.js index.html 404.html ./
RUN mkdir data /data && printf 'export const DEMO_DOCUMENTS = [];\n' > data/demo-documents.js && chown node:node /data
USER node
ENV NODE_ENV=production DOCFINDER_DATA_DIR=/data PORT=4175
EXPOSE 4175
CMD ["node", "scripts/serve-shared.mjs"]
