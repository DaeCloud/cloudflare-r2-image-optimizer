FROM node:22-alpine

# Install dcron (lightweight cron for Alpine)
RUN apk add --no-cache dcron

WORKDIR /app

COPY package.json ./

# Sharp bundles native libvips binaries per platform.
# npm_config_arch ensures the correct pre-built binary is fetched
# for the target platform rather than compiled under QEMU emulation,
# which causes the "Illegal instruction" crash on arm64 cross-builds.
ARG TARGETARCH
RUN npm install --production \
    --ignore-scripts \
    && SHARP_IGNORE_GLOBAL_LIBVIPS=1 \
       npm rebuild sharp --arch=${TARGETARCH}

COPY thumbnail-worker.js ./
COPY entrypoint.sh ./

RUN chmod +x entrypoint.sh

# Add cron job — runs daily at 2am
RUN echo "0 2 * * * node /app/thumbnail-worker.js >> /var/log/thumbnails.log 2>&1" \
    | crontab -

CMD ["./entrypoint.sh"]