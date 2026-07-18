#!/usr/bin/env bash
# eevee 上で実行する。tpl-ubuntu-noble から private-isu 問題 VM (vmid 9100) を構築する。
# 事前に user-data.build.yaml を /var/lib/vz/snippets/private-isu-build.yaml に置くこと。
set -euxo pipefail

BASE=9000
VMID=9100
SNIPPET=/var/lib/vz/snippets/private-isu-build.yaml

[ -f "$SNIPPET" ] || { echo "snippet not found: $SNIPPET" >&2; exit 1; }
if qm status "$VMID" &>/dev/null; then
  echo "vmid $VMID already exists" >&2
  exit 1
fi

qm clone "$BASE" "$VMID" --name tpl-private-isu-build --full
qm set "$VMID" --memory 4096 --cores 2 \
  --cicustom "user=local:snippets/private-isu-build.yaml" \
  --ipconfig0 ip=dhcp
qm start "$VMID"

echo "waiting for cloud-init (初回は 10 分以上かかる)..."
SECONDS=0
MAX_WAIT=${MAX_WAIT:-2400}
while true; do
  if [ "$SECONDS" -ge "$MAX_WAIT" ]; then
    echo "timeout: cloud-init が ${MAX_WAIT}s 以内に完了しなかった。VM は残したままにする。" >&2
    echo "状況確認: qm guest exec $VMID -- cloud-init status" >&2
    exit 1
  fi
  out=$(qm guest exec "$VMID" -- cloud-init status 2>/dev/null || true)
  echo "$out" | grep -q "status: done" && break
  if echo "$out" | grep -q "status: error"; then
    echo "cloud-init failed. ログ: qm guest exec $VMID -- tail -50 /var/log/cloud-init-output.log" >&2
    exit 1
  fi
  sleep 30
  echo "  ... ${SECONDS}s"
done
echo "cloud-init done in ${SECONDS}s"
