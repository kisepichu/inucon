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

## リスク 2: Proxmox API トークンの最小権限 → ✅ 発行・実測済み

eevee に portal 専用ロール `InuconPortal`(root/Administrator は使わない)+ ユーザー `portal@pve`(ログイン不可・トークンのみ)+ ACL(`/` に InuconPortal、propagate)を作成。トークン `portal@pve!inucon`(privsep=0)を発行し、値は apphost の `~/.inucon/portal-env`(k8s Secret の元)へ格納(リポジトリ・チャットには出さない)。

確定した最小 privilege(実際の API 呼び出しで削り込み・実測):

```
VM.Clone, VM.Allocate, VM.Audit,
VM.Config.Disk, VM.Config.Network, VM.Config.Options, VM.Config.Cloudinit, VM.Config.CDROM,
VM.PowerMgmt,
VM.GuestAgent.Audit, VM.GuestAgent.Unrestricted,
Datastore.AllocateSpace, Datastore.Audit,
SDN.Use,
Sys.Audit    # ← /nodes/eevee/status(RAM ガード)に必須。VM.Audit だけでは data:null で拒否される
```

- 注: `VM.Monitor` は PVE 9 では無効な priv 名(role add が失敗する)。guest agent 権限は `VM.GuestAgent.*` に細分化されている。
- 実測: このトークンで `GET /nodes/eevee/status`(mem.free 取得)/ `GET /nodes/eevee/qemu`(VM 一覧 6 台)/ `GET .../storage/local/content?content=snippets`(snippet 一覧)が成功。clone/start/exec の書き込み系は Task 3 の Live 実装で通す。
- env のキー: `PROXMOX_API_URL`(=`https://192.0.2.10:8006/api2/json`)、`PROXMOX_TOKEN_ID`(=`portal@pve!inucon`)、`PROXMOX_TOKEN_SECRET`。TLS は自己署名のため CloudflarePort/ProxmoxPort の HttpClient は検証スキップ(LAN 内固定ホスト)。

## リスク 5: Cloudflare Access アプリ数の上限

Cloudflare Zero Trust の Self-hosted Access アプリは無料プラン(最大 50 seats)でもアプリ数自体に固定の小さな上限は明記されていない(seat = 認証ユーザー数の制限が主)。競技規模(2〜3 チーム × 0〜3 台 = 最大 ~9 SSH ホスト名)では問題にならない。開催前に実数で確認する程度でよい(TODO 据え置き)。

## Step 6: benchvm トンネルの remotely managed 化 → ✅ 完了(重要な訂正あり)

**重大な訂正**: Phase 2 のスペック/メモの「apphost トンネルは remotely managed で、ローカル config の ingress は無視される」という記述は**誤り**だった。実測の真実:

- `cloudflared tunnel run --config <file>` 起動は**常にローカル ingress を使う**。ローカル config から ingress を消すと「No ingress rules ... will return 503」になり、remote 設定を pull しない。
- **remotely managed にするには `cloudflared tunnel run --token <TOKEN>`(env `TUNNEL_TOKEN`)で起動する**必要がある。この TOKEN は tunnel credentials(credentials.json)とは別物で、CF API `GET /accounts/<acc>/cfd_tunnel/<id>/token` で取得する。token 起動時のみ cloudflared は remote 設定を pull し、ログに `Updated to new configuration ... version=N` が出る。
- したがって apphost の `inucon.kisen.one` は**ローカル ingress**(nixos PR #7 で追加した `services.cloudflared` の記述)で動いている。apphost はまだ locally managed。

**benchvm で実施した内容**:
1. CF API で tunnel token を取得 → benchvm の `/root/.inucon-tunnel-env`(`TUNNEL_TOKEN=...`、root 600。**TODO: 開催前に agenix 化**)に格納
2. NixOS の `services.cloudflared`(module、ローカル ingress)を廃し、`systemd.services.cloudflared-inucon`(`cloudflared tunnel --no-autoupdate run`、EnvironmentFile で token 注入)に置き換え(`hosts/benchvm/configuration.nix`)
3. デプロイ後、`cloudflared-inucon` が remote 設定(team1-1/team2-1)を pull し version=2 を適用、`ssh inucon-team{N}-{M}.kisen.one` が通ることを確認
4. **動的 ingress の実証**: CF API で `inucon-team1-2.kisen.one → ssh://10.100.1.12:22` を追加 → 数秒で cloudflared が version=3 を pull(ログに team1-2 出現)→ 削除で version=4。**ポータルが CF API で ingress を増減すれば benchvm に即反映される**ことを確認。これが Phase 3 のインスタンス増減の SSH 経路の基盤。

**Phase 3 の CloudflarePort への含意**: `ensureInstanceRoute` / `removeInstanceRoute` は DNS CNAME upsert に加えて **tunnel configurations の GET → ingress 配列を編集(catch-all の前に挿入 / 該当ホスト削除)→ PUT** で実装する(全置換 PUT なので既存エントリを保持すること)。apphost 側は変更不要(ポータル自身の公開はローカル ingress のまま)。

## 追加の後片付け・申し送り

- Phase 2 スペック/メモの「apphost は remotely managed」記述を訂正する(別途小 PR、または Phase 3 実装の中で更新)。
- benchvm token は暫定ファイル。開催前に agenix 化(runner-env と同じ TODO 群)。
- リスク 1/3/4/5 と Step 2/6 すべて完了。Task 2 以降(portal コード)に進める。
