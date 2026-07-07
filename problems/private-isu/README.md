# private-isu 問題テンプレート (vmid 9100 / tpl-private-isu)

[matsuu/cloud-init-isucon](https://github.com/matsuu/cloud-init-isucon) の
`private-isu/app.cfg`(競技者用 cloud-config)を元に、Proxmox 上で
private-isu(Pixiv 社内 ISUCON 2016)の問題テンプレート VM を構築する。

## ファイル

| ファイル | 役割 |
| --- | --- |
| `user-data.build.yaml` | matsuu の `app.cfg` に qemu-guest-agent(packages 追加 + runcmd 先頭で enable --now)を統合した cloud-config |
| `build-template.sh` | eevee 上で実行。tpl-ubuntu-noble (9000) を full clone して 9100 を作り、cloud-init 完了までポーリング |
| `finalize-template.sh` | eevee 上で実行。cloud-init clean 等のクリーンアップ後にテンプレート化 |

## 使い方

```bash
scp problems/private-isu/user-data.build.yaml root@192.0.2.10:/var/lib/vz/snippets/private-isu-build.yaml
ssh root@192.0.2.10 'bash -s' < problems/private-isu/build-template.sh
# アプリ動作検証(下記)ののち
ssh root@192.0.2.10 'bash -s' < problems/private-isu/finalize-template.sh
```

## 実測記録(2026-07-08 構築)

matsuu の cloud-config が Proxmox(qm cicustom + NoCloud)でそのまま動くことを確認した。

- **構築所要時間**: スクリプト開始 02:54:16 JST → cloud-init 完了 03:08:12 JST(約 14 分。
  full clone 含む)。ゲスト内の cloud-init ログでは `finished ... Up 822.51 seconds`
  (VM 起動から約 13 分 43 秒)。Ansible の結果は `ok=93 changed=77 failed=0`。
- **アプリ動作検証**: `curl http://<VM IP>/` → HTTP `200`。
- **確認したサービス名**(すべて active/running):
  - `nginx.service`
  - `mysql.service`(MySQL Community Server)
  - `memcached.service`
  - `isu-ruby.service`(アプリ本体。デフォルト実装は Ruby)
- **テンプレートのディスク使用量**(`zfs list | grep 9100`):

  ```
  rpool/data/base-9100-disk-0   7.24G   904G  7.24G  -
  rpool/data/vm-9100-cloudinit    76K   904G    76K  -
  ```

## 補足

- matsuu リポジトリの private-isu には `app.cfg` / `benchmarker.cfg` / `standalone.cfg` の
  3 種があり、本テンプレートは競技者用の `app.cfg` を採用(ベンチマーカーは別途)。
  `app.cfg` は catatsuy/private-isu の Ansible playbook を `--skip-tags nodejs` で流す構成。
- finalize で `cloud-init clean --logs`・`/etc/machine-id` の初期化・SSH ホスト鍵削除を
  行っているため、クローン起動時に新しい user-data(SSH 鍵・ホスト名)が適用される。
- ビルド VM のポーリングは `qm guest exec 9100 -- cloud-init status` を利用
  (qemu-guest-agent を統合したのはこのため)。guest agent が起動するまでは
  exec がエラーになるが、スクリプトは無視してリトライする。
