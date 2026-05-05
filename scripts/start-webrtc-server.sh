#!/bin/bash

SERVER_SCRIPT_PATH=./node_modules/y-webrtc/bin/server.js
PORT=4444
echo "Starting y-webrtc server on port ${PORT}"
node $SERVER_SCRIPT_PATH 