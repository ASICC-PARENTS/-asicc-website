#!/usr/bin/env bash
set -euo pipefail
wrangler dev --config worker/bazaar/wrangler.local.toml --ip 127.0.0.1 --port 8787 --test-scheduled > /tmp/asicc-worker-ci.log 2>&1 &
worker_pid=$!
trap 'kill "$worker_pid" 2>/dev/null || true; cat /tmp/asicc-worker-ci.log' EXIT
ready=false
for i in $(seq 1 60); do
  if curl --silent --max-time 2 --output /dev/null http://127.0.0.1:8787/; then ready=true; break; fi
  if ! kill -0 "$worker_pid" 2>/dev/null; then exit 1; fi
  sleep 1
done
if [ "$ready" != true ]; then echo "Local Worker not ready"; exit 1; fi
node --test worker/bazaar/integration.test.mjs worker/bazaar/readiness.test.mjs
