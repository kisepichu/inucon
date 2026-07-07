#!/usr/bin/env bash
# eevee 上で実行する。Ubuntu 24.04 cloud image から汎用テンプレート (vmid 9000) を作る。
set -euxo pipefail

VMID=9000
IMG=/root/noble-server-cloudimg-amd64.img

if qm status "$VMID" &>/dev/null; then
  echo "vmid $VMID already exists" >&2
  exit 1
fi

wget -q -O "$IMG" https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img

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
