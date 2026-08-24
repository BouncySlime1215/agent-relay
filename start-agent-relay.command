#!/bin/bash
set -e
cd "$(dirname "$0")"
node relay/server.mjs &
relay_pid=$!
sleep 1
open "http://127.0.0.1:4317"
wait "$relay_pid"
