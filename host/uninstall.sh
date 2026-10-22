#!/bin/sh
# Removes the Model Asker host registration on Linux.  Usage:  sh host/uninstall.sh
set -eu

HOST_NAME="com.model_asker.host"
HOST_DIR=$(cd "$(dirname "$0")" && pwd)
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

for browser in google-chrome google-chrome-beta google-chrome-unstable chromium BraveSoftware/Brave-Browser microsoft-edge microsoft-edge-beta vivaldi; do
  rm -f "$CONFIG_HOME/$browser/NativeMessagingHosts/$HOST_NAME.json"
done
rm -f "$HOST_DIR/model_asker_host.sh"
echo "Host removed."
