FROM node:22.23.4-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
EXPOSE 3000
# New Relic: app name and license key come from the deploy config / Vault.
# Without NEW_RELIC_LICENSE_KEY the agent stays off and the server runs as before.
ENV NEW_RELIC_LOG=stdout \
    NEW_RELIC_LOG_LEVEL=warn \
    NEW_RELIC_APPLICATION_LOGGING_FORWARDING_ENABLED=false
CMD ["node", "--import", "newrelic/esm-loader.mjs", "-r", "newrelic", "dist/index.js"]
