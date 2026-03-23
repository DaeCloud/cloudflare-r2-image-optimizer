#!/bin/sh
set -e

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Container started."

# Run once immediately on startup so you don't have to wait for the first cron tick
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Running initial thumbnail pass..."
node /app/thumbnail-worker.js

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Starting cron daemon (daily at 02:00 UTC)..."

# Start busybox crond in foreground (-f) with log level 2 (-l 2)
# -d 8 sends debug output to stderr so logs are visible via docker logs
exec crond -f -d 8