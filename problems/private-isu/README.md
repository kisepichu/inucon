# private-isu 問題テンプレート (vmid 9100 / tpl-private-isu)

[matsuu/cloud-init-isucon](https://github.com/matsuu/cloud-init-isucon) の
`private-isu/app.cfg`(競技者用 cloud-config)を元に、Proxmox 上で
private-isu(Pixiv 社内 ISUCON 2016)の問題テンプレート VM を構築する。

## ファイル

| ファイル | 役割 |
| --- | --- |
| `user-data.build.yaml` | matsuu の `app.cfg` に qemu-guest-agent(packages 追加 + runcmd 先頭で enable --now)を統合した cloud-config |
| `build-template.sh` | eevee 上で実行。tpl-ubuntu-noble (9000) を full clone して 9100 を作り、cloud-init 完了までポーリング |
| `patch-app.sh` | eevee 上で実行。ベンチ失敗の恒久修正(下記)を nginx 設定へ適用して reload。冪等 |
| `finalize-template.sh` | eevee 上で実行。cloud-init clean 等のクリーンアップ後にテンプレート化 |

## 使い方(build → patch → 検証 → finalize)

```bash
scp problems/private-isu/user-data.build.yaml root@192.0.2.10:/var/lib/vz/snippets/private-isu-build.yaml
ssh root@192.0.2.10 'bash -s' < problems/private-isu/build-template.sh
# ベンチ失敗の恒久修正パッチを適用(必須。下記「恒久修正パッチ」参照)
ssh root@192.0.2.10 'bash -s' < problems/private-isu/patch-app.sh
# アプリ動作検証(下記)とパッチ効果確認を行ったあと
ssh root@192.0.2.10 'bash -s' < problems/private-isu/finalize-template.sh
```

## 恒久修正パッチ(patch-app.sh)

### 根本原因

private-isu ベンチマーカー(Go `net/http.Client`)は画像投稿 `POST /` への 302 を
自動追従して `GET /posts/:id` を送る際、**同一ホスト内リダイレクトでは元 POST の
`Content-Type: multipart/form-data; boundary=...` ヘッダをボディの無い GET にも
そのまま引き継ぐ**(Go 標準ライブラリの既定動作)。一方 Rack 3.2.6 の
`Request#form_data?` は **HTTP メソッドを見ず Content-Type の値だけで multipart
判定する**ため、ボディの無い GET を multipart として解析しようとして
`Rack::Multipart::EmptyContentError` → Sinatra が `400 Bad Request` を返す。
ベンチは起動直後のサニティチェック(`postImageScenario`)でこの 400 を踏んで
1 件 fail し、即 `pass:false` 終了する(60 秒の本負荷フェーズに到達しない)。
タイミング非依存の 100% 決定的なバグ。

### 修正内容

nginx リバースプロキシ層で **GET/HEAD リクエストのみ** upstream(Unicorn)へ渡す
`Content-Type` を空にする(POST 等ボディを伴うリクエストには影響しない)。

- `/etc/nginx/conf.d/strip-get-content-type.conf`(新規): `map $request_method $upstream_content_type { default $http_content_type; GET ""; HEAD ""; }`
- `/etc/nginx/sites-available/isucon.conf` の `location /` に `proxy_set_header Content-Type $upstream_content_type;` を 1 行追加
  (`sites-enabled/isucon.conf` は `sites-available/isucon.conf` への symlink で同一実体。
  デバッグレポートの `sites-enabled` 表記と本書の `sites-available` 表記は同じファイルを指す)

matsuu 由来の `user-data.build.yaml` は原本無改変ポリシーのため変更せず、
ビルドフローの独立ステップ(`patch-app.sh`、`qm guest exec 9100` 経由)として適用する。
スクリプトは冪等(二重適用ガード付き。何度実行しても同じ結果)で、適用後に
`nginx -t` と `systemctl reload nginx` を行う。

### 効果確認(eevee から。`<VMのIP>` は `qm guest cmd 9100 network-get-interfaces` で確認)

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://<VMのIP>/          # -> 200(通常動作)
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Content-Type: multipart/form-data; boundary=x" http://<VMのIP>/posts/1
# -> 200(パッチ前は 400。これがベンチ fail の再現条件)
```

## 実測記録(2026-07-08 構築)

matsuu の cloud-config が Proxmox(qm cicustom + NoCloud)でそのまま動くことを確認した。

- **構築所要時間**: スクリプト開始 02:54:16 JST → cloud-init 完了 03:08:12 JST(約 14 分。
  full clone 含む)。ゲスト内の cloud-init ログでは `finished ... Up 822.51 seconds`
  (VM 起動から約 13 分 43 秒)。Ansible の結果は `ok=93 changed=77 failed=0`。
  なおスクリプト自身の `cloud-init done in NNNNs` 出力は、実行元 ssh セッションが
  途中で切断されたため得られておらず、上記はゲスト内ログからの実測値(構築自体は
  VM 内で継続するため切断の実害はない。長時間ビルドは tmux/nohup 推奨)。
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

## 実測記録(2026-07-08 パッチ焼き込み再ビルド)

恒久修正パッチをテンプレートに焼き込むため、テンプレート(9100)とチーム VM を
破棄して build → patch → 検証 → finalize → terraform apply を通しで再実施した。

- **再ビルド所要時間**: `build-template.sh` の `cloud-init done in 803s`(約 13.4 分。
  full clone 含む)。
- **patch-app.sh 適用**: `nginx -t` OK → reload OK。再実行して冪等性も確認
  (`proxy_set_header Content-Type` 行が重複しないこと)。
- **効果確認**(eevee から、パッチ適用後・finalize 前):
  - `GET /` → `200`
  - `GET /posts/1`(`Content-Type: multipart/form-data; boundary=x` 付き)→ `200`
    (パッチ前は `400`)
- **チーム VM 再払い出し**: `terraform apply` 19.4 秒(4 added / 0 destroyed。
  linked clone のため高速)。
- **再ベンチ(benchvm → team1-1 = 10.100.1.11, 2vCPU/4GB)3 回**、全て `pass:true` / `fail:0`:

  | 回 | score | success | fail | 実行時間 |
  | --- | --- | --- | --- | --- |
  | 1 | 1032 | 899 | 0 | 1m17.6s |
  | 2 | 1030 | 897 | 0 | 約1m17s |
  | 3 | 1041 | 908 | 0 | 約1m17s |

  実行時間は毎回約 77 秒(60 秒の本負荷フェーズ + 10 秒待機 + 前処理)で、
  本負荷フェーズを完走している。スコアのばらつきは 1030〜1041(約 1%)と小さく、
  順番実行なら計測として十分安定している。
- **ベンチ中の eevee ホスト負荷**(run 1 中に `top -b -n3 -d5; free -h` で取得):

  ```
  load average: 0.53, 0.39, 0.65
  %Cpu(s): 9.1 us, 9.1 sy, 81.1 id
  MiB Mem: 28802.9 total, 8493.3 free, 19982.4 used, 805.9 buff/cache
  ```

  team1-1 の kvm プロセスが CPU 約 109%(2vCPU 中 約 1.1 コア相当)、ホスト全体は
  81% アイドルで余裕あり。スワップ使用なし。2vCPU/4GB で 60 秒本負荷を問題なく
  完走できることを確認した。

## ベンチ実行(benchvm から)(2026-07-08 実測)

> **注**: 本節の `pass:false` は調査時点の記録。その後の再調査で根本原因は
> read-after-write 競合ではなく「Go リダイレクト GET の Content-Type 引き継ぎ ×
> Rack 3.2.6 の multipart 判定」と判明し(詳細は上記「恒久修正パッチ」節)、
> 上記「恒久修正パッチ」で解消済み(再ベンチ 3 回 `pass:true`)。

benchvm(192.0.2.5, NixOS)から inucon-team1-1(10.100.1.11, 2vCPU/4GB, vmid 1101)
に対して private-isu の公式ベンチマーカーを実行し、縮小スペックでの動作を検証した。

### ビルド手順(brief の想定との差分あり)

```bash
ssh kise@<benchvmのLAN IP>
git clone --depth 1 https://github.com/catatsuy/private-isu.git
cd private-isu/benchmarker
```

`benchmarker/README.md` は存在しない(ビルド・実行手順はリポジトリ直下の `README.md`
「手元で動かす」節に記載)。brief 想定と異なった点は以下の 3 つ:

1. **`gcc` が無く `make` が失敗する**(cgo 依存: `math/rand/v2` 等ではなく実際は
   Go 標準ライブラリのビルド自体が cgo 経由で `net` パッケージ等を要求するため)。
   NixOS のシステムには `git`/`go`/`make`/`curl` はあるが `gcc` は無いため、
   `nix shell nixpkgs#gcc -c make` でビルドする必要があった。
   (`bin/benchmarker` 生成まで実測 **約 5 秒**。Go モジュール取得込みでも
   ネットワークが十分速ければ数秒〜数十秒。)
2. **`userdata/img/` が空(gitignore 対象)**。この状態で実行すると
   `panic: invalid argument to IntN`(`util.RandomNumber` が画像 0 枚に対して
   乱数範囲 0 を要求してクラッシュ)になる。画像はリポジトリ直下の
   `make init`(`benchmarker/userdata/img.zip` を GitHub Releases から取得して
   unzip)で用意する想定だが、**benchvm のルートディスクが 4.6GB しかなく
   `dump.sql.bz2`(1.2GB, webapp 用で不要)+ `img.zip`(1.2GB)+ 展開後画像で
   容量不足になり `make init` が `curl: (23) Failure writing output` で失敗**した。
   対処: `webapp/sql/dump.sql.bz2` は削除(ベンチには不要)、`img.zip` は
   フルダウンロード後 `unzip img.zip "img/000*" -d .` で
   `userdata.go` の `Glob(userdata + "/img/000*")` パターンに合う分だけ選択的に
   展開(198ファイル, 93MB)して `img.zip` を削除。これでベンチは正常に動作した
   (画像バリエーションが全量 10,005 枚中 198 枚に減るが、ベンチ動作自体には支障なし)。
   **benchvm のディスクは 4.6GB → 実運用では増設を推奨**(懸念として記録)。
3. `unzip`/`gcc` は `nix shell nixpkgs#<pkg> -c <cmd>` で都度取得する運用で問題なし。

```bash
cd ~/private-isu/benchmarker
nix shell nixpkgs#gcc -c make
nix shell nixpkgs#unzip -c unzip -l ../../img.zip   # 中身確認(未展開のまま一覧のみ)
```

### 実行コマンド

```bash
cd ~/private-isu/benchmarker
time ./bin/benchmarker -u ./userdata -t http://10.100.1.11
```

### 実測結果: 2vCPU/4GB(現行スペック)

計 6 回実行、**全回で同一パターンの `pass:false`** (スコアは常に 74 で分散なし):

```
{"pass":false,"score":74,"success":71,"fail":1,"messages":["ステータスコードが正しくありません: expected 200, got 400 (GET /posts/10001)"]}
{"pass":false,"score":74,"success":71,"fail":1,"messages":["ステータスコードが正しくありません: expected 200, got 400 (GET /posts/10002)"]}
{"pass":false,"score":74,"success":71,"fail":1,"messages":["ステータスコードが正しくありません: expected 200, got 400 (GET /posts/10006)"]}
{"pass":false,"score":74,"success":71,"fail":1,"messages":["ステータスコードが正しくありません: expected 200, got 400 (GET /posts/10007)"]}
{"pass":false,"score":74,"success":71,"fail":1,"messages":["ステータスコードが正しくありません: expected 200, got 400 (GET /posts/10008)"]}
```

- 実行時間: `real 0m7.2s`〜`0m7.6s`(brief 想定の 60〜75 秒より大幅に短い)。
- **`/initialize` はタイムアウトしていない**。`GET /initialize` は単独で `200`
  を返すことを curl で確認済み。ベンチは「本番の 60 秒間の負荷生成フェーズ」に
  到達する前の、起動直後の DOM サニティチェック(`postImageScenario` = ログイン
  → 画像投稿 → リダイレクト先 `/posts/:id` を GET してDOMを検証)の時点で
  `score.GetInstance().GetFails() > 0` により**即時 fail 終了**している
  (`cli.go` のロジック上、ここで fail が出ると `ExitCodeError` で即座に返る)。

### 4vCPU への一時変更後の再測(brief Step 2 の contingency 手順)

brief の指示に従い、`pass:false` を受けて eevee 上で team1-1 を一時的に 4vCPU に変更し
再測した(`cores` 変更はホットプラグ非対応のため VM 再起動が必要だった)。

```bash
ssh root@192.0.2.10 'qm set 1101 --cores 4'
ssh root@192.0.2.10 'qm reboot 1101'
# 起動待ち後
ssh kise@<benchvm> 'cd private-isu/benchmarker && ./bin/benchmarker -u ./userdata -t http://10.100.1.11'
```

結果: **4vCPU でも全く同一の失敗パターンが再現**した(3 回実行、いずれも
`score:74, success:71, fail:1`, 実行時間 7.2〜7.5 秒)。したがって

- **今回観測された `pass:false` は 2vCPU/4GB のスペック不足が原因ではない**
  (`/initialize` タイムアウトではなく、CPU を倍にしても症状が不変)。
- 検証後、`qm set 1101 --cores 2` → `qm reboot 1101` で 2vCPU に復旧済み。

### 根本原因の切り分け(read-after-write の競合と推定)[この仮説は後の調査で誤りと判明。正しい原因は上記「恒久修正パッチ」参照]

`curl` で同じ POST → redirect 追跡を手動再現したところ:

- POST 完了後、**別プロセスの curl で少し間を置いて GET**(数十ms以上)すると
  ほぼ確実に `200`(投稿した記事が見える)。
- 同一 curl プロセス内で `-L`(即座にリダイレクト追跡)すると、**5/5 回とも
  `404`**(投稿した記事が「存在しない」扱いになる)。ベンチマーカー本体も
  Go の `http.Client` が同一コネクションで即座にリダイレクトを追うため、この
  パターンで `400`/`404` を踏んでいると考えられる。

つまり「画像投稿 → 直後にその投稿ページを読む」という read-after-write の
ごく短い時間窓(数十ミリ秒オーダー)で不整合が起きており、**CPU/メモリのスペックとは
無関係にベンチが本走行(60秒間のスコアリングフェーズ)まで到達できない**状態。
原因は private-isu アプリ側(DB接続の扱い、nginx 側の設定等)にあると推測されるが、
benchvm/team1-1 いずれからも DB(3306)や systemd サービスへの直接アクセス権限が
無いため、アプリプロセス内部までは特定できていない。**Task 6 のプロビジョニング内容
(matsuu app.cfg 由来の nginx/unicorn 設定)を確認できる権限を持つ担当者による追加調査が必要**。

### ホスト負荷観測(eevee, Step 3)

ベンチ実行と並行して eevee 上で `top -b -n3 -d5; free -h` を取得:

```
load average: 0.22, 0.36, 0.43
%Cpu(s): 8.3 us, 9.0 sy, 0.0 ni, 81.9 id
MiB Mem: 28802.9 total, 8339.1 free, 20136.2 used, 800.9 buff/cache
```

- ホスト(eevee)は 81.9% アイドルで余裕があり、`apphost`(vmid 100, ホストOS上の
  常駐 KVM プロセス)も CPU 18% 程度で窒息の兆候なし。
- ただし今回のベンチは前述の通り 7 秒程度で早期 fail 終了するため、**60秒間の
  本負荷フェーズを流した状態でのホスト負荷は未取得**(取得できたのは起動直後の
  軽量な 71 リクエスト分の負荷のみ)。read-after-write の問題が解消され次第、
  本負荷時のホスト負荷を再取得する必要がある。

### スコアのばらつき

早期 fail のため毎回 `score:74`(`success:71, fail:1`)で固定、分散なし。
本負荷フェーズに到達した場合のスコアのばらつきは今回測定できていない。

## 補足

- matsuu リポジトリの private-isu には `app.cfg` / `benchmarker.cfg` / `standalone.cfg` の
  3 種があり、本テンプレートは競技者用の `app.cfg` を採用(ベンチマーカーは別途)。
  `app.cfg` は catatsuy/private-isu の Ansible playbook を `--skip-tags nodejs` で流す構成。
- finalize で `cloud-init clean --logs`・`/etc/machine-id` の初期化・SSH ホスト鍵削除を
  行っているため、クローン起動時に新しい user-data(SSH 鍵・ホスト名)が適用される。
- ビルド VM のポーリングは `qm guest exec 9100 -- cloud-init status` を利用
  (qemu-guest-agent を統合したのはこのため)。guest agent が起動するまでは
  exec がエラーになるが、スクリプトは無視してリトライする。
