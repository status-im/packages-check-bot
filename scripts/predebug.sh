#!/bin/bash

APP_PORT=3000
APP_PID="$(lsof -i :${APP_PORT} | awk 'NR!=1 {print $2}' | sort -u | tr '\r\n' ' ')"
if [ ! -z "$APP_PID" ]; then
  kill $APP_PID
fi
