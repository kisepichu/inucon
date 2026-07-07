#!/usr/bin/env bash
# eevee 上で実行する。構築済み VM 9100 をクリーンアップしてテンプレート化する。
set -euxo pipefail
VMID=9100

qm guest exec "$VMID" -- bash -c \
  'cloud-init clean --logs && truncate -s 0 /etc/machine-id && rm -f /etc/ssh/ssh_host_*'
qm shutdown "$VMID" --timeout 180
qm set "$VMID" --name tpl-private-isu --delete cicustom --ipconfig0 ip=dhcp
qm template "$VMID"
echo "done: tpl-private-isu ($VMID)"
