# INUCON デプロイ手順(runbook)

初期セットアップ(Phase 2 Task 11 当時の手順)と、通常運用の再デプロイ手順をまとめる。
実行にはそれぞれの資格情報(apphost SSH 鍵、Cloudflare API トークン、nixos-config-private への書き込み権限)が要る。
コンテスト当日の運営作業は `docs/runbooks/contest-operations.md` を参照。

## 運用ポリシー: 本番 = main(Phase 3 以降)

- **本番(apphost の inucon-portal)は常に `main` ブランチと同一内容**にする。
- 流れ: タスクごとのブランチ → PR → develop にマージ(ローカル codex レビュー)→
  デプロイしたくなったら **develop → main の PR を作ってマージ → main からデプロイ**。
- main へのマージ = デプロイ意思表示。デプロイせずに main を進めない(乖離を作らない)。

## 通常の再デプロイ手順(Phase 3 Task 7 で確立した反復ループ)

前提: デプロイ内容が main にマージ済みで、手元の main が origin/main と一致していること。

```sh
# 0. main を同期
git switch main && git pull --ff-only

# 1. amd64 クロスビルド(Apple Silicon から。apphost は amd64)
docker buildx build --platform linux/amd64 \
  -f deploy/Dockerfile -t ghcr.io/kisepichu/inucon-portal:latest --load .

# 2. tarball にして apphost へ転送(レジストリ不使用)
docker save ghcr.io/kisepichu/inucon-portal:latest | gzip > /tmp/inucon-portal.tar.gz
scp /tmp/inucon-portal.tar.gz apphost.kisen.one:/tmp/

# 3. containerd に取り込み(sudo パスワード対話が要るので TTY 付き)
ssh -t apphost.kisen.one \
  'gunzip -c /tmp/inucon-portal.tar.gz | sudo k3s ctr images import - && rm /tmp/inucon-portal.tar.gz'

# 4. 入れ替え(起動時にマイグレーションが自動適用される)
ssh apphost.kisen.one \
  'kubectl -n inucon rollout restart deployment/inucon-portal && \
   kubectl -n inucon rollout status deployment/inucon-portal --timeout=180s'

# 5. 確認
curl -s -o /dev/null -w '%{http_code}\n' https://inucon.kisen.one/api/health   # 200
ssh apphost.kisen.one 'kubectl -n inucon logs deploy/inucon-portal --tail=20'
```

### DB マイグレーションを含むデプロイの注意

- マイグレーションは **pod 起動時に自動適用**(forward-only、`effect_sql_migrations` で管理)。
- **スキーマ変更を含むデプロイの前にはバックアップを取る**。pod 内の better-sqlite3 で
  整合スナップショットを作り、手元に取り出す:
  ```sh
  POD=$(ssh apphost.kisen.one 'kubectl -n inucon get pods -o name' | head -1 | cut -d/ -f2)
  ssh apphost.kisen.one "kubectl -n inucon exec -i $POD -- node -e \"const D=require('/app/node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3');new D('/data/portal.db',{readonly:true}).backup('/data/backup.db').then(()=>console.log('OK'))\""
  ssh apphost.kisen.one "kubectl -n inucon exec -i $POD -- cat /data/backup.db" > ./portal-backup-$(date +%Y%m%d).db
  ssh apphost.kisen.one "kubectl -n inucon exec -i $POD -- rm /data/backup.db"
  ```
  (better-sqlite3 のパスは pnpm のバージョンで変わる。`find /app/node_modules/.pnpm -maxdepth 1 -name 'better-sqlite3*'` で確認)
- 大きな移行(テーブル再構築等)は、スナップショットのコピーに対して手元で
  ドライラン(`DB_PATH=<copy> pnpm exec tsx` でマイグレータを起動)してから本番に流す
  (Phase 3 の 0002/0003 で実施した手順。詳細:
  `docs/superpowers/reviews/2026-07-18-phase3-task7-verification.md` ステップ0)。

### ロールバック

イメージタグは `:latest` 運用のため、ロールバック = **問題のコミットを revert して main に積み、
上記ループで再デプロイ**(main の force-push はしない)。マイグレーションは
forward-only なのでスキーマは戻せない — スキーマを含む場合はバックアップからの復元になる
(pod 停止 → PVC の portal.db をバックアップで置換 → 旧イメージ起動)。

## 0. 前提

- イメージ: `deploy/Dockerfile`(multi-stage、`node:22-slim` 統一)。ローカルで以下を確認済み:
  - `pnpm -r typecheck && pnpm -r test` 全緑
  - `docker build -f deploy/Dockerfile -t inucon-portal:local .` 成功
  - `docker run` で起動し `/api/health` 200・`/` が SPA の index.html・seed(contests 1 行、`INUCON`/`private-isu`/`preparing`)を確認済み(詳細は `.superpowers/sdd/task-11-report.md`)
  - ローカル `docker run` で DB ファイルへの書き込み確認時は、`-v` マウント先ディレクトリの所有者・権限に注意（node ユーザー UID 1000 で実行するため、ホストの `chmod 777` または Docker Desktop の fsGroup 対応で対処）
- k8s マニフェスト: `deploy/k8s/{namespace,pvc,deployment,service,ingress}.yaml`
- 対象クラスタ: apphost(192.0.2.20、NixOS + k3s。`ssh apphost.kisen.one` で入れる)
- ランナー対象ホスト: benchvm(192.0.2.5、NixOS。bench 環境は Phase 1 で配置済み)

## 1. GitHub OAuth App 作成(ブラウザ作業・ユーザー依頼)

ポータルの認証(GitHub OAuth)用。以下はブラウザでの手動作業のため、資格情報を持つユーザー自身が行うこと。

1. https://github.com/settings/developers → "New OAuth App"
2. 入力値:
   - Application name: `INUCON`(任意)
   - Homepage URL: `https://inucon.kisen.one`
   - Authorization callback URL: `https://inucon.kisen.one/auth/github/callback`
3. 作成後に発行される **Client ID** と **Client Secret** を控える(次節の k8s Secret 作成で使う)。Client Secret は再表示できないので必ずこの場でコピーする。

## 2. イメージ build & apphost へのインポート(レジストリ不使用)

**採用方式(Phase 2 実績)**: 公開レジストリ(ghcr.io)には push せず、amd64 でビルドした
イメージを tarball にして apphost へ転送し、`k3s ctr images import` で containerd に直接
取り込む(下記手順例のとおり scp の 2 段方式。import に必要な sudo がパスワード対話を
要求するため、stdin をパイプで塞ぐストリーミング 1-liner とは両立しない)。イメージを
公開面に出さずに済み、imagePullSecret も不要。
`deployment.yaml` の `imagePullPolicy: IfNotPresent` はこの方式の前提
(`Always` だと push していない = レジストリ側に存在しないイメージを pull しようとして失敗する)。

**重要: ビルドマシンの CPU アーキテクチャが Apple Silicon(arm64)の場合、デプロイ先の apphost が amd64 VM のため、クロスビルドが必須です。そのまま `docker build` を実行すると、apphost で `exec format error` で起動に失敗します。**

```sh
# amd64 クロスビルド(ローカルに保持)
docker buildx build --platform linux/amd64 \
  -f deploy/Dockerfile \
  -t ghcr.io/kisepichu/inucon-portal:latest \
  --load \
  .

# apphost へ転送してインポート(import は root 必要 = sudo パスワード対話)
docker save ghcr.io/kisepichu/inucon-portal:latest | gzip > /tmp/inucon-portal.tar.gz
scp /tmp/inucon-portal.tar.gz kise@192.0.2.20:/tmp/
ssh -t kise@192.0.2.20 \
  'gunzip -c /tmp/inucon-portal.tar.gz | sudo k3s ctr images import - && rm /tmp/inucon-portal.tar.gz'

# 反映(イメージタグが同じ場合は rollout restart で入れ替え)
ssh kise@192.0.2.20 'kubectl rollout restart deployment/inucon-portal -n inucon'
```

ローカルで動作確認したい場合(arm64 イメージを使う):
```sh
# クロスビルドなし、ローカル動作確認用(:local タグを使う)
docker build -f deploy/Dockerfile -t inucon-portal:local .
docker run -p 3000:3000 inucon-portal:local
```

(将来 ghcr.io 配布に切り替える場合は `--push` + Package を Public 化 +
`imagePullPolicy: Always` に戻す。)

## 3. k8s Secret 作成

`inucon-portal-env` という名前の Secret に、ポータルが読む機密環境変数をまとめて入れる(`deployment.yaml` は `envFrom.secretRef` でこの Secret を丸ごと注入する)。

**重要: 値の安全な渡し方**

コマンド置換を使った `printf` 方式は、展開値が kubectl の argv に入るため、`ps` で確認できてしまいます。代わりに一時ファイル方式を使ってください:

```sh
ssh apphost.kisen.one

kubectl create namespace inucon --dry-run=client -o yaml | kubectl apply -f -

# 一時 env ファイルを安全に作成(mode 0600)
umask 077
cat > /tmp/inucon-env << 'EOF'
GITHUB_CLIENT_ID=REPLACE_ME_GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET=REPLACE_ME_GITHUB_CLIENT_SECRET
ADMIN_GITHUB_LOGINS=kisepichu
RUNNER_TOKEN=REPLACE_ME_RUNNER_TOKEN
BASE_URL=https://inucon.kisen.one
EOF

# Secret を作成
kubectl create secret generic inucon-portal-env \
  --namespace inucon \
  --from-env-file=/tmp/inucon-env \
  --dry-run=client -o yaml | kubectl apply -f -

# ファイルは使用後に削除
rm /tmp/inucon-env
```

環境変数の説明:
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`: 手順 1 で発行した値
- `RUNNER_TOKEN`: ランナー(benchvm)と共有する bearer token。`openssl rand -hex 32` などで生成した値を使う。手順 6 の agenix secret と同じ値にすること
- `ADMIN_GITHUB_LOGINS`: 管理者の GitHub login をカンマ区切りで(例: `kisepichu`)
- `BASE_URL`: OAuth コールバックの組み立てに使う。手順 1 の Homepage URL と一致させる

再作成(値の更新)時は `kubectl delete secret inucon-portal-env -n inucon` してから同じコマンドを再実行するか、上記のように `--dry-run=client -o yaml | kubectl apply -f -` で上書き適用する。

## 4. kubectl apply

```sh
# apphost 上、または kubeconfig を持つマシンから
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f deploy/k8s/pvc.yaml
kubectl apply -f deploy/k8s/deployment.yaml
kubectl apply -f deploy/k8s/service.yaml
kubectl apply -f deploy/k8s/ingress.yaml

kubectl -n inucon rollout status deployment/inucon-portal
kubectl -n inucon get pods,svc,ingress
```

`deployment.yaml` の image は `ghcr.io/kisepichu/inucon-portal:latest`(imagePullPolicy: Always)。再デプロイのたびに新しいタグを push した場合は、latest 運用なら
`kubectl -n inucon rollout restart deployment/inucon-portal` で最新イメージを引き直す。

## 5. apphost cloudflared に inucon.kisen.one を追加

**訂正(Phase 3 spike で判明)**: apphost のトンネル(0000bbbb-...)は **locally managed**。
`cloudflared tunnel run --config <file>`(= NixOS の `services.cloudflared` モジュールが
生成する起動方式)は**常にローカル config の ingress を使い、Cloudflare 側の remote 設定を
無視する**(remote を pull させるには `--token` 起動が必要 — benchvm 参照)。よって
`inucon.kisen.one` は `nixos-config-private` PR #7 で追加した apphost の**ローカル ingress**
(`services.cloudflared ... "inucon.kisen.one" = "http://127.0.0.1:80"`)で稼働している。
Phase 2 の当ドキュメントの「remotely managed」記述は誤りだった。

手順:

1. DNS: `CNAME inucon.kisen.one -> 0000bbbb-...cfargotunnel.com`(proxied)を作成
   (`infra/.cf-api-token`、DNS Edit 権限)。
2. `nixos-config-private` の `hosts/apphost` の `services.cloudflared` ingress に
   `"inucon.kisen.one" = "http://127.0.0.1:80"` を追加(PR #7 で実施済み)し、nixos-rebuild。
3. firewall(NodePort 30080 の LAN 許可)も NixOS 側が実体。
4. 確認: `curl -s -o /dev/null -w '%{http_code}\n' https://inucon.kisen.one/api/health` が `200` を返すこと。

> benchvm のトンネル(0000aaaa、チーム SSH)は Phase 3 で **token 方式の remotely managed** に
> 切り替えた(ポータルがインスタンス増減で ingress を CF API から動的更新するため)。apphost
> とは方式が異なる(apphost はローカル config で十分なため据え置き)。詳細:
> `docs/superpowers/research/2026-07-11-phase3-spike.md`。

## 6. benchvm にランナーを配置(systemd)

ランナー(`runner/`)は benchvm 上に常駐プロセスとして置く。こちらも実体は `nixos-config-private` の `hosts/benchvm` に systemd unit を追加する形になる(このリポジトリには手順のみ記載)。

systemd unit は `nixos-config-private/hosts/benchvm` に定義済み(nixos-config-private #7:
User=kise、WorkingDirectory=/home/kise/inucon、EnvironmentFile=/home/kise/.inucon/runner-env、
Restart=always)。アプリの配置・更新手順(Phase 2 実績):

1. ソース配置とビルド(benchvm は private リポジトリの認証を持たないため rsync 方式):
   ```sh
   # 手元(リポジトリルート)から。benchvm の IP は DHCP で変動する(下記 §8)ので都度確認
   rsync -a --delete --exclude .git --exclude node_modules --exclude dist \
     --exclude .superpowers --exclude portal/data --exclude portal/web/dist \
     ./ kise@<benchvm-ip>:/home/kise/inucon/
   ssh kise@<benchvm-ip> \
     'cd ~/inucon && pnpm install --frozen-lockfile && pnpm --filter shared build && pnpm --filter runner build'
   ```
2. 環境変数ファイル `/home/kise/.inucon/runner-env`(kise 所有 600。**TODO: 開催前に agenix 化**):
   ```
   PORTAL_URL=http://192.0.2.20:30080
   RUNNER_TOKEN=<apphost の ~/.inucon/runner-token と同じ値>
   BENCH_DIR=/home/kise/private-isu/benchmarker
   ```
   `PORTAL_URL` は LAN 直結の NodePort(30080)。Tunnel(https://inucon.kisen.one)を経由しない。
   `POLL_INTERVAL_MILLIS` / `PROGRESS_INTERVAL_MILLIS` は既定値(2000ms / 5000ms)のままで問題なければ省略可。
3. `sudo systemctl restart inucon-runner` → `systemctl status inucon-runner` で起動確認。
4. 確認: `journalctl -u inucon-runner -f` で poll が回っていること(job なし時は静かに poll し続ける)。ポータルからベンチを 1 件 enqueue して、実行・進捗・finish が通ることまで確認する。

## 7. 動作確認チェックリスト

- [ ] `https://inucon.kisen.one/api/health` が 200
- [ ] `https://inucon.kisen.one/` が SPA を返す
- [ ] GitHub OAuth ログインが成功し、`ADMIN_GITHUB_LOGINS` に含まれるユーザーで管理操作(`/api/admin/contest/start` 等)ができる
- [ ] benchvm の `inucon-runner` が起動し、ポータルへの poll がログで確認できる
- [ ] enqueue → poll → progress → finish → scoreboard 反映が一通り通る(実ベンチ)

## 8. 既知の注意点

- `replicas: 1` 固定(SQLite 単一ファイルのため)。`strategy: Recreate` にしてあるので、デプロイ時は数秒のダウンタイムが出る(身内利用のため許容)
- ランナー→ポータルの経路は NodePort(`30080`)の LAN 直結で運用中(Phase 2 実測で疎通確認済み)。apphost の firewall は LAN サブネット(192.0.2.0/24)からの 30080 のみ許可(nixos-config-private #8)
- **benchvm の LAN IP は DHCP で変動する**(実測で 192.0.2.5 → .11 に変わった)。SSH やベンチ VM の経路には影響しないが、rsync 先の指定時は `ssh root@192.0.2.10 'qm guest cmd 9200 network-get-interfaces'` 等で現在値を確認する
- Secret の値はリポジトリに絶対に入れない(このファイルのコマンド例はすべてプレースホルダ)
- ポータルの実測(2026-07-10): 実ベンチ score 1077 / 902 / 990(Phase 1 の CLI 実測と同水準、ばらつき約 ±9%)、実行中 cancel 409、ベンチ異常終了の failed 報告、ランナー停止→608 秒で timeout 回収、をすべて確認済み
