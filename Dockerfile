FROM mcr.microsoft.com/playwright:v1.54.1-jammy

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json yarn.lock ./
RUN npm install

COPY . .

CMD ["npm", "start"]
