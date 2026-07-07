# eevee 事前整備 runbook

## 目的

Proxmox ホスト `eevee`(192.0.2.10)は Terraform をはじめとする以後の全タスクの前提となる。
このドキュメントは、その前提を整えるために行った唯一の「手作業」の記録であり、同じ手順を再実行・検証できるようにするための runbook である。

## 実施日

2026-07-08 (JST)

## 実施方法

- Step 1〜4: eevee の WebUI(`https://192.0.2.10:8006`)→ eevee → 右上「>_ Shell」から実行。
- Step 2 のうち zfs.conf の書き換えのみ、WebUI シェルではなく Mac から `ssh root@192.0.2.10` 経由で実施(理由は Step 2 参照)。
- Step 5: Mac のターミナルから実行。

---

## Step 1: 現状把握(RAM 内訳・ZFS ARC)

```bash
qm list && pct list
free -h
arc_summary -s arc | head -20
```

結果:

```
# qm list && pct list
      VMID NAME                 STATUS     MEM(MB)    BOOTDISK(GB) PID
       100 apphost              running    8192              64.00 1801
(pct list: コンテナなし)

# free -h (ARC 制限前)
               total        used        free      shared  buff/cache   available
Mem:            28Gi        14Gi        13Gi        54Mi       612Mi        13Gi
Swap:             0B          0B          0B

# arc_summary -s arc | head -20 (抜粋)
ZFS Subsystem Report  Linux 7.0.6-2-pve  2.4.2-pve1
ARC status:
        Total memory size:                                      28.1 GiB
        Min target size:                                3.1 %  900.1 MiB
        Max target size:                               21.3 %    6.0 GiB
        Target size (adaptive):                        61.9 %    5.4 GiB
        Current size:                                  61.9 %    3.7 GiB
        Free memory size:                                       13.4 GiB
```

結論(スペックの未確認事項の検証結果): 「使用 14GiB」の内訳は apphost 8GiB + ZFS ARC 3.7GiB + PVE ホスト約 2GiB。ARC 仮説どおりで、コンテナ・他 VM は存在しない。

---

## Step 2: ZFS ARC 上限を 4GiB に制限(即時 + 永続)

計画からの変更点: 計画では `zfs-arc-max.conf` という専用ファイルを新規作成する想定だったが、確認したところ `/etc/modprobe.d/zfs.conf` が**既に存在**しており、PVE インストーラによる `options zfs zfs_arc_max=6442450944`(6GiB)が入っていた。この状態で計画どおり別ファイル `zfs-arc-max.conf` を追加すると、`/etc/modprobe.d/` はアルファベット順に読み込まれるため `zfs.conf`(6GiB)が `zfs-arc-max.conf`(4GiB)より後に読まれて再起動時に上書き・優先されてしまう。そのため方針を変更し、**既存の `zfs.conf` の値を直接 4294967296 に書き換え、(WebUI シェルで一度作成してしまった)`zfs-arc-max.conf` は削除して 1 ファイルに統合**した。この統合作業のみ SSH 経由(Mac から `ssh root@192.0.2.10`)で実施した。

実行コマンド:

```bash
echo 4294967296 > /sys/module/zfs/parameters/zfs_arc_max
cat /etc/modprobe.d/zfs.conf 2>/dev/null   # 既存設定の存在と値(6GiB)を確認
# 既存の zfs.conf を書き換えて統合(実際に実行したコマンド):
sed -i "s/zfs_arc_max=6442450944/zfs_arc_max=4294967296/" /etc/modprobe.d/zfs.conf
rm /etc/modprobe.d/zfs-arc-max.conf   # WebUI シェルで作成済みだった重複ファイルを削除
update-initramfs -u -k all
free -h
```

実施後の状態(検証済み):

```
# cat /etc/modprobe.d/zfs.conf
options zfs zfs_arc_max=4294967296

# cat /sys/module/zfs/parameters/zfs_arc_max
4294967296

# update-initramfs -u -k all  実行済み

# free -h (実施後)
               total        used        free      shared  buff/cache   available
Mem:            28Gi        14Gi        13Gi        54Mi       719Mi        13Gi
```

補足: ARC のシュリンクは即座には反映されない場合があり、`available` が大きく増えるまで数分かかることがある。apphost は無停止のまま作業を完了した。

---

## Step 3: local ストレージに snippets を許可

`pvesm set` の `--content` は追加指定ではなく指定一覧への**上書き**であるため、既存の content 一覧を確認したうえで snippets を追加した文字列を渡した。

実行コマンド:

```bash
grep -A5 "^dir: local$" /etc/pve/storage.cfg   # 変更前の content を確認
pvesm set local --content iso,vztmpl,backup,import,snippets
grep -A5 "^dir: local$" /etc/pve/storage.cfg   # 変更後を確認
mkdir -p /var/lib/vz/snippets
```

結果:

```
変更前: dir: local / path /var/lib/vz / content iso,vztmpl,backup,import
変更後: dir: local / path /var/lib/vz / content import,vztmpl,backup,snippets,iso  (既存種別は維持されたまま snippets が追加)
```

補足: `local` は `import` content にも対応しており cloud image の import-from に使える。`local-zfs` は zfspool `rpool/data` であり本作業の対象外。

---

## Step 4: Terraform 用ユーザーと API トークン作成

```bash
pveum user add terraform@pve --comment "inucon terraform"
pveum aclmod / -user terraform@pve -role Administrator
pveum user token add terraform@pve tf --privsep 0
```

`--privsep 0` はトークンがユーザー(terraform@pve)の権限をそのまま継承する設定。簡便な反面、トークン単体の漏洩がユーザー権限の漏洩と等価になる。より安全にするなら `--privsep 1` で発行し、トークン ID(`terraform@pve!tf`)に対して `pveum aclmod` で必要最小限の ACL を個別付与する選択肢がある(Phase 3 のカスタムロール移行時に合わせて検討)。

結果: `full-tokenid = terraform@pve!tf` が発行された。**トークンの value(シークレット)はこの runbook には記載しない**(表示は一度きりのため、実施者が別途安全な方法で保管し、Task 3 の `terraform.tfvars` に設定する)。

Administrator ロールの付与は Phase 1 における簡便設定であり、トークン漏洩時の影響範囲がクラスタ全体に及ぶ点に留意すること。Phase 3 でポータルに常駐させる際は `VM.*` / `Datastore.*` / `SDN.*` 等に絞ったカスタムロールへ移行する。

---

## Step 5: Mac の SSH 公開鍵を eevee root に登録

bpg Terraform provider の snippets アップロードおよび VMA 転送に使用する。

```bash
ssh-copy-id root@192.0.2.10
ssh root@192.0.2.10 hostname  # => eevee
```

結果: Mac の公開鍵は root@eevee に**既に登録済み**であり、`ssh-copy-id` は "already exist" として skip された。`ssh root@192.0.2.10` でパスワードなしにログインできることを確認済み。

注意: root への公開鍵登録はホスト全体の掌握と等価であり、鍵の漏洩・端末紛失時の影響が最も大きい。この構成は「自宅 LAN 内からのみ到達可能なホストへ、管理者本人の端末から接続する」前提の簡便設定である。bpg provider の snippets アップロードが SSH を要求するため Phase 1 では root を使うが、リスクを下げるなら (1) 専用ユーザー + 必要ディレクトリへの書き込み権限、(2) `authorized_keys` の `from="192.0.2.0/24"` オプションによる接続元制限、を検討する。

---

## RAM 予算の確定値

合計メモリ 28.1GiB。ARC を 4GiB に制限した後の内訳計画:

- apphost: 8GiB
- benchvm: 4GiB
- チーム VM: 4GiB × 2
- ZFS ARC: 4GiB(上限)
- PVE ホスト: 約 2GiB

合計 ≈ 26GiB。Phase 1 の「2 チーム × 1 台」構成であれば 28.1GiB に収まる。
