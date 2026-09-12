#!/usr/bin/env bash
# Menjalankan Cloudflare Tunnel dan otomatis mencatat URL aktif ke .env

ENV_FILE="/home/ubuntu/clipperVPS/.env"
SERVER_ENV="/home/ubuntu/clipperVPS/server/.env"
LOG_FILE="/tmp/tunnel_live.log"

rm -f "$LOG_FILE"
LAST_URL=""

# Jalankan cloudflared sambil mem-pipe log
cloudflared tunnel --url http://localhost:3000 2>&1 | tee "$LOG_FILE" | while read -r line; do
  if [[ "$line" =~ (https://[a-zA-Z0-9-]+\.trycloudflare\.com) ]]; then
    TUNNEL_URL="${BASH_REMATCH[1]}"
    if [ "$TUNNEL_URL" != "$LAST_URL" ]; then
      LAST_URL="$TUNNEL_URL"
      echo "Detected Tunnel URL: $TUNNEL_URL"
      
      # Update di .env jika ada
      if [ -f "$ENV_FILE" ]; then
        sed -i '/CLOUDFLARE_TUNNEL_URL=/d' "$ENV_FILE"
        echo "CLOUDFLARE_TUNNEL_URL=$TUNNEL_URL" >> "$ENV_FILE"
      fi
      if [ -f "$SERVER_ENV" ]; then
        sed -i '/CLOUDFLARE_TUNNEL_URL=/d' "$SERVER_ENV"
        echo "CLOUDFLARE_TUNNEL_URL=$TUNNEL_URL" >> "$SERVER_ENV"
      fi
    fi
  fi
done
