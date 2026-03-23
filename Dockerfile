FROM node:22-alpine

# Install dcron (lightweight cron for Alpine)
RUN apk add --no-cache dcron

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY thumbnail-worker.js ./
COPY entrypoint.sh ./

RUN chmod +x entrypoint.sh

# Add cron job — runs daily at 2am
RUN echo "0 2 * * * node /app/thumbnail-worker.js >> /var/log/thumbnails.log 2>&1" \
    | crontab -

CMD ["./entrypoint.sh"]