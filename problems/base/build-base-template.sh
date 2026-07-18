#!/usr/bin/env bash
# eevee 上で実行する。Ubuntu 24.04 cloud image から汎用テンプレート (vmid 9000) を作る。
set -euxo pipefail

VMID=9000
# current を使う(最新のセキュリティ更新入りイメージで作る)。過去イメージで再現したい場合は
# BASE_URL=https://cloud-images.ubuntu.com/releases/noble/release-YYYYMMDD 等で上書きする。
BASE_URL=${BASE_URL:-https://cloud-images.ubuntu.com/noble/current}
IMG_NAME=noble-server-cloudimg-amd64.img
IMG=/root/$IMG_NAME

if qm status "$VMID" &>/dev/null; then
  echo "vmid $VMID already exists" >&2
  exit 1
fi

# ダウンロードした image は /root に残置(約 3.5GiB)。再実行時に再利用されるため
# 意図的に削除しない。不要になったら手動削除
wget -q -O "$IMG" "$BASE_URL/$IMG_NAME"
wget -q -O /root/SHA256SUMS "$BASE_URL/SHA256SUMS"
(cd /root && grep "[ *]$IMG_NAME\$" SHA256SUMS | sha256sum -c -)

qm create "$VMID" --name tpl-ubuntu-noble --ostype l26 \
  --memory 4096 --cores 2 --cpu host \
  --net0 virtio,bridge=vmbr0 \
  --scsihw virtio-scsi-single --agent enabled=1 \
  --serial0 socket --vga serial0
qm set "$VMID" --scsi0 "local-zfs:0,import-from=$IMG"
qm disk resize "$VMID" scsi0 20G
qm set "$VMID" --ide2 local-zfs:cloudinit --boot order=scsi0
qm template "$VMID"
echo "done: tpl-ubuntu-noble ($VMID)"
