#!/bin/sh
set -eu
umask 077

RELEASE_BASE_URL=${NOVA_RUNNER_RELEASE_URL:-https://github.com/hu-bo/nova/releases/latest/download}
ASSET=nova-runner-linux-x64.tar.gz
SERVER=
TOKEN=
WORKSPACE=
RUNNER_ID=

usage() {
  printf '%s\n' \
    'Usage: install-runner.sh --server <url> --token <token> [--workspace <path>] [--runner-id <id>]' \
    '' \
    'Installs a systemd boot service that runs Nova Runner as the current user.'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --server)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      SERVER=$2
      shift 2
      ;;
    --token)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      TOKEN=$2
      shift 2
      ;;
    --workspace)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      WORKSPACE=$2
      shift 2
      ;;
    --runner-id)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      RUNNER_ID=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[ -n "$SERVER" ] || { printf '%s\n' '--server is required' >&2; exit 2; }
[ -n "$TOKEN" ] || { printf '%s\n' '--token is required' >&2; exit 2; }

case "$SERVER" in
  http://*|https://*) ;;
  *) printf '%s\n' '--server must start with http:// or https://' >&2; exit 2 ;;
esac

case "$(uname -s):$(uname -m)" in
  Linux:x86_64|Linux:amd64) ;;
  *) printf 'Unsupported platform: %s %s\n' "$(uname -s)" "$(uname -m)" >&2; exit 1 ;;
esac

for command in awk curl getent install sed tar systemctl; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'Required command is not installed: %s\n' "$command" >&2
    exit 1
  }
done

if [ "$(id -u)" -eq 0 ]; then
  RUN_USER=${SUDO_USER:-}
  [ -n "$RUN_USER" ] || {
    printf '%s\n' 'Run as a regular user, or use sudo so SUDO_USER identifies the Runner owner.' >&2
    exit 1
  }
  as_root() { "$@"; }
else
  RUN_USER=$(id -un)
  command -v sudo >/dev/null 2>&1 || {
    printf '%s\n' 'sudo is required to install the boot service' >&2
    exit 1
  }
  as_root() { sudo "$@"; }
fi

id "$RUN_USER" >/dev/null 2>&1 || { printf 'Linux user does not exist: %s\n' "$RUN_USER" >&2; exit 1; }
RUN_GROUP=$(id -gn "$RUN_USER")
USER_HOME=$(getent passwd "$RUN_USER" | awk -F: 'NR == 1 { print $6 }')
[ -n "$USER_HOME" ] || { printf 'Unable to find home directory for: %s\n' "$RUN_USER" >&2; exit 1; }
[ -n "$WORKSPACE" ] || WORKSPACE=$USER_HOME
[ -d "$WORKSPACE" ] || { printf 'Workspace does not exist: %s\n' "$WORKSPACE" >&2; exit 2; }

TEMP_DIRECTORY=$(mktemp -d)
trap 'rm -rf "$TEMP_DIRECTORY"' EXIT HUP INT TERM

printf '%s\n' 'Downloading Nova Runner…'
curl -fL --retry 3 --connect-timeout 15 "$RELEASE_BASE_URL/$ASSET" -o "$TEMP_DIRECTORY/$ASSET"
curl -fL --retry 3 --connect-timeout 15 "$RELEASE_BASE_URL/SHA256SUMS" -o "$TEMP_DIRECTORY/SHA256SUMS"

EXPECTED=$(awk -v asset="$ASSET" '$2 == asset || $2 == "*" asset { print $1; exit }' "$TEMP_DIRECTORY/SHA256SUMS")
[ -n "$EXPECTED" ] || { printf '%s\n' "Checksum for $ASSET is missing" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "$TEMP_DIRECTORY/$ASSET" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL=$(shasum -a 256 "$TEMP_DIRECTORY/$ASSET" | awk '{print $1}')
else
  printf '%s\n' 'sha256sum or shasum is required to verify the download' >&2
  exit 1
fi
[ "$EXPECTED" = "$ACTUAL" ] || { printf '%s\n' 'Nova Runner checksum verification failed' >&2; exit 1; }

tar -xzf "$TEMP_DIRECTORY/$ASSET" -C "$TEMP_DIRECTORY"
[ -f "$TEMP_DIRECTORY/nova-runner" ] || { printf '%s\n' 'Release archive does not contain nova-runner' >&2; exit 1; }

CONFIG_PATH=/var/lib/nova-runner/config.toml
UNIT_PATH=/etc/systemd/system/nova-runner.service

toml_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

CONFIG_SOURCE=$TEMP_DIRECTORY/config.toml
{
  printf 'server = "%s"\n' "$(toml_escape "$SERVER")"
  printf 'token = "%s"\n' "$(toml_escape "$TOKEN")"
  printf 'workspace = "%s"\n' "$(toml_escape "$WORKSPACE")"
  if [ -n "$RUNNER_ID" ]; then
    printf 'runner_id = "%s"\n' "$(toml_escape "$RUNNER_ID")"
  fi
} > "$CONFIG_SOURCE"
chmod 600 "$CONFIG_SOURCE"

unit_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/%/%%/g'
}

UNIT_SOURCE=$TEMP_DIRECTORY/nova-runner.service
cat > "$UNIT_SOURCE" <<UNIT
[Unit]
Description=Nova Runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
Environment="HOME=$(unit_escape "$USER_HOME")"
Environment="PATH=$(unit_escape "$PATH")"
ExecStart=/usr/local/bin/nova-runner --config $CONFIG_PATH
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

if as_root systemctl cat nova-runner.service >/dev/null 2>&1; then
  as_root systemctl stop nova-runner.service
fi
as_root install -m 755 "$TEMP_DIRECTORY/nova-runner" /usr/local/bin/nova-runner
as_root install -d -m 700 -o "$RUN_USER" -g "$RUN_GROUP" /var/lib/nova-runner
as_root install -m 600 -o "$RUN_USER" -g "$RUN_GROUP" "$CONFIG_SOURCE" "$CONFIG_PATH"
as_root install -m 644 "$UNIT_SOURCE" "$UNIT_PATH"
as_root systemctl daemon-reload
as_root systemctl enable --now nova-runner.service >/dev/null

printf '%s\n' 'Nova Runner is installed and running.'
printf '%s\n' 'Status: sudo systemctl status nova-runner'
printf '%s\n' 'Logs:   sudo journalctl -u nova-runner -f'
