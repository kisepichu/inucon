# チーム間ネットワーク分離(FORWARD DROP ルール)

## 背景・問題

Task 6(`infra/team-vms.tf`)の検証で、チーム VM 間(`team1-1` ↔ `team2-1`)の通信が
遮断されずに到達してしまう問題が見つかった(詳細は `.superpowers/sdd/task-6-report.md` の
「チーム間分離失敗の原因調査」参照)。

原因は Proxmox SDN の `simple` ゾーン(`infra/sdn.tf`)の仕様:

- `simple` ゾーンは vnet(`team1`/`team2`)ごとに独立したブリッジを作り、
  `net.ipv4.conf.<vnet>.forwarding = 1` を設定してインターネットへの SNAT
  (アウトバウンド)を実現する。
- しかし **vnet 間のトラフィックを遮断する iptables/firewall ルールは自動生成しない**。
- ホスト eevee は `team1`(10.100.1.0/24)・`team2`(10.100.2.0/24)の両サブネットに
  直接 `scope link` で接続しており、両インターフェースで forwarding が有効
  (`net.ipv4.conf.vmbr0.forwarding = 1`)なため、`FORWARD` チェーンのポリシーが
  `ACCEPT` のままだとカーネルが team1↔team2 間を素直にルーティングしてしまう。
- Proxmox Datacenter Firewall は未設定(`/etc/pve/firewall/cluster.fw` は空、
  `pve-firewall status` は `disabled/running`)。

一方でベンチ VM `benchvm` は各 vnet(10.100.1.2 / 10.100.2.2)に直接 L2 の足を持つため、
チーム VM への通信は同一サブネット内で完結し `FORWARD` チェーンを通らない。
また、チーム VM のアウトバウンド(SNAT 経由のインターネットアクセス)は宛先が
`10.100.0.0/16` 外なので、`10.100.0.0/16 → 10.100.0.0/16` のみを DROP する対策では
影響を受けない。

したがって **「送信元・宛先とも `10.100.0.0/16` の FORWARD トラフィックを DROP する」**
ルールだけで、チーム間通信のみを狙って遮断できる。

## 適用したルール

eevee(`ssh root@192.0.2.10`)の `iptables` FORWARD チェーンの先頭(1 番目)に
以下のルールを追加した(既存ルールの削除・変更なし、INPUT/OUTPUT には触れていない):

```
iptables -I FORWARD 1 -s 10.100.0.0/16 -d 10.100.0.0/16 -j DROP
```

適用後の `iptables -S FORWARD`:

```
-P FORWARD ACCEPT
-A FORWARD -s 10.100.0.0/16 -d 10.100.0.0/16 -j DROP
-A FORWARD -j ts-forward
```

(`ts-forward` は既存の Tailscale 用チェーンで、今回変更していない)

## 永続化(systemd unit)

再起動後も iptables ルールが失われないよう、eevee に以下の oneshot unit を配置し
`enable --now` した。

`/etc/systemd/system/inucon-team-isolation.service`:

```ini
[Unit]
Description=INUCON team VNet isolation (drop inter-team forwarding)
After=network.target pve-firewall.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'iptables -C FORWARD -s 10.100.0.0/16 -d 10.100.0.0/16 -j DROP 2>/dev/null || iptables -I FORWARD 1 -s 10.100.0.0/16 -d 10.100.0.0/16 -j DROP'

[Install]
WantedBy=multi-user.target
```

`ExecStart` は `iptables -C`(チェック)で既存ルールの有無を確認し、無い場合のみ
`-I`(挿入)する冪等な実装になっている。そのため再起動時だけでなく、手動で
`systemctl restart inucon-team-isolation.service` しても二重にルールが積まれない。

有効化:

```
systemctl daemon-reload
systemctl enable --now inucon-team-isolation.service
systemctl status inucon-team-isolation.service
```

## 検証結果(2026-07-08 実施)

すべて eevee 経由の `qm guest exec`、および benchvm(`kise@192.0.2.14`)から実施。

```
== team1(1101) -> team2(10.100.2.11), 期待値 ISOLATED ==
1 packets transmitted, 0 received, 100% packet loss
ISOLATED

== team2(1201) -> team1(10.100.1.11), 期待値 ISOLATED ==
1 packets transmitted, 0 received, 100% packet loss
ISOLATED

== team1(1101) outbound curl https://github.com, 期待値 200 ==
200

== benchvm(kise@192.0.2.14) -> team1(10.100.1.11) / team2(10.100.2.11), 期待値 両方成功 ==
10.100.1.11: 64 bytes, 0% packet loss
10.100.2.11: 64 bytes, 0% packet loss

== team1(1101) -> benchvm の同一サブネット内の足 10.100.1.2, 期待値 成功(仕様上OK) ==
64 bytes from 10.100.1.2: icmp_seq=1 ttl=64 time=0.283 ms
```

- チーム間分離: **成功**(team1→team2、team2→team1 とも ISOLATED)
- チーム VM のアウトバウンド(SNAT): **維持**(200)
- ベンチ VM benchvm からチーム VM への経路: **維持**(両サブネットとも到達)
- チーム VM → benchvm の同一サブネットの足(10.100.1.2 等)への到達性: **意図的に許可のまま**。
  ポータル/ランナー API はアプリケーション層のトークン認証で保護する前提であり、
  L3 レベルでの遮断は本対策のスコープ外。

## 再適用手順

VM 追加やホスト再構築などで unit ファイルが失われた場合は、上記
「永続化(systemd unit)」の手順をそのまま再実行すればよい(冪等)。
ルールの存在確認のみ行いたい場合:

```
ssh root@192.0.2.10 "iptables -C FORWARD -s 10.100.0.0/16 -d 10.100.0.0/16 -j DROP && echo OK"
systemctl status inucon-team-isolation.service
```

## 既知の制約・今後の検討事項

- 本対策はホスト eevee 上の iptables による応急対応であり、Terraform では管理していない
  (`infra/sdn.tf` はコメントでこの対応を参照するのみ)。将来的に Proxmox Datacenter
  Firewall や SDN サブネットの `firewall` オプションで同等の分離を宣言的に管理できるなら、
  そちらへの移行を検討する。
- チーム数が増えて `10.100.0.0/16` 以外のレンジを使う場合は、ルールの CIDR 見直しが必要。
