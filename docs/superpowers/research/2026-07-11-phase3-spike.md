# Phase 3 spike 結果(2026-07-11)

計画 `docs/superpowers/plans/2026-07-10-phase3-selfservice.md` Task 1 の実測。スペックのリスク 1〜5 を実機(eevee)で確定する。

## 結論(採用する払い出しレシピ)

**初期払い出し = linked clone + snippet(cicustom)+ ipconfig0**、**既存 VM への鍵追加 = guest-exec** の 2 本立て。両方とも実測で成功した。

Terraform(bpg/proxmox)が team VM をこのレシピで作っている(`qm config 1101`: `cicustom: user=local:snippets/inucon-team1-1.yaml` + `ipconfig0` + `net0 bridge=team1`)。Phase 3 の ProxmoxPort はこれを生 API で駆動する。

## リスク 1: linked clone + cloud-init は fresh clone に適用されるか → ✅ 適用される

使い捨て VM(vmid 1109 = `vmidFor(1,9)`、IP 10.100.1.19 = `ipFor(1,9)`、bridge team1)で検証:

```sh
# 1. linked clone(--full 0。--storage は linked clone では指定不可 = 親を継承)
qm clone 9100 1109 --name inucon-spike --full 0
# 2. snippet を local:snippets に置き(下記)、cicustom + ネットワークを設定
qm set 1109 --cicustom "user=local:snippets/inucon-spike.yaml" \
  --ipconfig0 gw=10.100.1.1,ip=10.100.1.19/24 --nameserver 1.1.1.1 \
  --net0 virtio,bridge=team1,firewall=0
# 3. 起動 → cloud-init が新 instance-id で走り、IP と snippet の鍵が入る
qm start 1109
```

snippet(user-data)の形:

```yaml
#cloud-config
users:
  - name: isucon
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - ssh-ed25519 AAAA... spike@inucon
```

結果: 起動後 guest agent の `network-get-interfaces` に 10.100.1.19 が出た。snippet の鍵で `ssh -J kise@benchvm -i spike_key isucon@10.100.1.19` に成功(authorized_keys 1 行)。**fresh linked clone でも cloud-init のネットワーク・ユーザー・鍵が適用される**ことを確認。

- snippet ファイルの実体は eevee の `/var/lib/vz/snippets/`(= `local:snippets/`)。生 API では `POST /nodes/eevee/storage/local/upload`(multipart、content=snippets)でアップロードする(Task 3 で実装・確認)。
- 代替(cloud-init 非依存の guestExec で IP まで注入)は不要だった。ネットワークは ipconfig0 に任せる。

## リスク 3: guest agent exec で既存 VM に鍵追記できるか → ✅ できる

同 VM に 2 本目の鍵を guest-exec で追記:

```sh
qm guest exec 1109 -- /bin/sh -c 'umask 077; mkdir -p /home/isucon/.ssh; \
  printf "%s\n" "<pubkey>" >> /home/isucon/.ssh/authorized_keys; \
  chown -R isucon:isucon /home/isucon/.ssh; wc -l /home/isucon/.ssh/authorized_keys'
# → {"exitcode":0, "out-data":"2 /home/isucon/.ssh/authorized_keys\n"}
```

追記した鍵で SSH 成功。**招待時の「既存 running VM への鍵注入」は guest-exec で成立**。

- `qm guest exec`(同期)は内部で exec → exec-status ポーリングをやってくれる。生 API では `POST /nodes/eevee/qemu/<vmid>/agent/exec`(pid が返る)→ `GET /nodes/eevee/qemu/<vmid>/agent/exec-status?pid=<pid>`(`exited`/`exitcode`/`out-data`)をポーリングする(Task 3)。
- 出力サイズ・タイムアウト: authorized_keys 操作は出力が小さく、即時に exited=1 になった。大きな出力を扱う用途はない(コマンドはコード内固定)。
- **セキュリティ**: 上記のとおりコマンドは固定で、可変部は公開鍵文字列のみ。計画の Global Constraints の authorized_keys 形式検証を通し、`printf "%s\n" "<検証済み鍵>"` の引数として渡す(改行・シェルメタ文字は形式検証で排除)。

## リスク 4: RAM ガードの閾値 → 実測材料

`pvesh get /nodes/eevee/status`(2026-07-11、Phase 1 フル構成稼働中): total 28.1GiB / used 22.2GiB / **free 5.6GiB**。ARC は max target 4.0GiB(Phase 1 で設定済み)。

- Proxmox の `memory.free` は ARC を「used」に含めた後の値(ARC は必要時に縮む余地があるが、保守的に free をそのまま見る)。
- **閾値の決定**: 1 インスタンス = 4GiB。作成前に `free ≥ 5GiB`(= 4GiB + 予備 1GiB)を要求する。現状 free 5.6GiB は team1-1/team2-1 稼働中の値なので、追加 1 台の余地はギリギリ。実運用は「重い私用 VM を止める」前提(親スペック)。
- ProxmoxPort.getNodeFreeMemBytes は `/nodes/eevee/status` の `memory.free` を返す。ユースケースが `< 5GiB` なら作成拒否(InstanceQuota とは別のガード)。

## リスク 2: Proxmox API トークンの最小権限 → **未実施(要ユーザー判断)**

トークン発行は新しい認証情報の作成なので、方式をユーザーに確認してから行う(下記「残: 要判断」)。必要になる privilege の見込み(Proxmox のロール権限名):

- `VM.Clone`(clone)、`VM.Config.Disk` / `VM.Config.Network` / `VM.Config.Options` / `VM.Config.Cloudinit`(config set)、`VM.PowerMgmt`(start/stop)、`VM.Monitor` / `VM.GuestAgent.Audit` / `VM.GuestAgent.Unrestricted`(guest exec — PVE 9 では guest-agent 権限が細分化)、`VM.Audit`(status)、`Datastore.AllocateSpace` + `Datastore.Audit`(snippet upload / disk)。
- スコープは `/vms`(competition VM 群)と対象 storage(`local` / `local-zfs`)に限定。Phase 1 の root/Administrator は portal に持ち込まない。
- 実際に必要な最小セットは、トークン発行後に Task 3 の実 API 呼び出しで削りながら確定する。

## リスク 5: Cloudflare Access アプリ数の上限

Cloudflare Zero Trust の Self-hosted Access アプリは無料プラン(最大 50 seats)でもアプリ数自体に固定の小さな上限は明記されていない(seat = 認証ユーザー数の制限が主)。競技規模(2〜3 チーム × 0〜3 台 = 最大 ~9 SSH ホスト名)では問題にならない。開催前に実数で確認する程度でよい(TODO 据え置き)。

## 残: 要ユーザー判断(Task 1 の Step 2 と Step 6)

1. **Proxmox API トークン発行**(Step 2): portal 用トークンを eevee で作る。新規認証情報の作成。値は apphost の k8s Secret にのみ入れる(リポジトリ・チャットに出さない)。
2. **benchvm トンネル(0000aaaa)の remotely managed 化**(Step 6): 現在ローカル config の ingress(team1-1/team2-1)を CF API の tunnel configurations に移す。移行中に既存の `ssh inucon-team{N}-{M}.kisen.one` 経路が一時的に切れる可能性がある。apphost(0000bbbb)は Phase 2 で既に remotely managed 化済みで、同じ運用に統一する。

上記 2 点はどちらも「破壊的/認証情報」に該当するため、ユーザーの合図を待って実施する。それ以外の spike(リスク 1/3/4/5)は完了。
