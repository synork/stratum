#!/usr/bin/with-contenv bashio
export PORT=8099
export DATA_DIR=/config
export HA_CONFIG_DIR=/homeassistant
export HA_BASE_URL=http://supervisor/core/api
export HA_WS_URL=ws://supervisor/core/websocket
export HA_TOKEN="${SUPERVISOR_TOKEN}"
HA_FRONTEND_URL="$(bashio::config 'ha_frontend_url')"
if [[ "${HA_FRONTEND_URL}" == "http://homeassistant.local:8123" ]]; then
  HA_FRONTEND_URL="http://homeassistant:8123"
fi
export HA_FRONTEND_URL
if bashio::config.has_value 'github_token'; then
  export GITHUB_TOKEN="$(bashio::config 'github_token')"
fi
exec node /app/apps/server/dist/index.js
