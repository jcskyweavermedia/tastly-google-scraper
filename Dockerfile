FROM apify/actor-node-playwright-chrome:20

COPY package*.json ./
RUN npm install --include=dev

COPY . ./
RUN npm run build \
    && npm prune --omit=dev
