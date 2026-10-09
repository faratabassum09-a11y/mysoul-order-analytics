FROM node:20-alpine AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client ./
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY server/package*.json server/
RUN npm --prefix server install --omit=dev
COPY server server
COPY --from=client /app/client/dist client/dist
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "server/src/index.js"]
