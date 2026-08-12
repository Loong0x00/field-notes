#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
install_dir=$HOME/.local/lib/field-notes-comments
config_dir=${XDG_CONFIG_HOME:-$HOME/.config}/field-notes-comments
unit_dir=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user

install -d -m 0700 "$install_dir" "$config_dir"
install -d -m 0755 "$unit_dir"

go -C "$project_dir/server" build -trimpath -ldflags='-s -w' -o "$install_dir/commentsd" ./cmd/commentsd
chmod 0700 "$install_dir/commentsd"
install -m 0644 "$project_dir/deploy/systemd/field-notes-comments.service" "$unit_dir/field-notes-comments.service"
install -m 0644 "$project_dir/deploy/systemd/field-notes-tunnel.service" "$unit_dir/field-notes-tunnel.service"

if [[ ! -e "$config_dir/comments.env" ]]; then
  install -m 0600 "$project_dir/deploy/comments.env.example" "$config_dir/comments.env"
fi
if [[ ! -e "$config_dir/cloudflared.yml" ]]; then
  install -m 0600 "$project_dir/deploy/cloudflared.yml.example" "$config_dir/cloudflared.yml"
fi

systemctl --user daemon-reload

printf '%s\n' "Installed Field Notes services. Fill comments.env and cloudflared.yml, then run:"
printf '%s\n' "  systemctl --user enable --now field-notes-comments.service field-notes-tunnel.service"
