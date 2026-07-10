# INUCON Phase 2 デプロイ手順(runbook)

Task 11 のうち、**ローカルで完結する部分**(Dockerfile / k8s マニフェスト / seed)はこのリポジトリのコミットで完了している。
このドキュメントは、それ以降の**リモート作業**(apphost への SSH・kubectl apply・ghcr push・Cloudflare 操作・GitHub OAuth App 作成)の手順書。
実行するにはそれぞれの資格情報(apphost SSH 鍵、ghcr push 権限、Cloudflare API トークン、nixos-config-private への書き込み権限)が要る。

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

## 2. イメージ build & push(ghcr.io)

**重要: ビルドマシンの CPU アーキテクチャが Apple Silicon(arm64)の場合、デプロイ先の apphost が amd64 VM のため、クロスビルドが必須です。そのまま `docker build` を実行すると、apphost で `exec format error` で起動に失敗します。**

amd64 への本番ビルド(リポジトリルートで実行):
```sh
# docker buildx を使ったクロスビルド(amd64 イメージを ghcr.io に直接 push)
docker buildx build --platform linux/amd64 \
  -f deploy/Dockerfile \
  -t ghcr.io/kisepichu/inucon-portal:latest \
  --push \
  .
```

ローカルで動作確認したい場合(arm64 イメージを使う):
```sh
# クロスビルドなし、ローカル動作確認用(:local タグを使う)
docker build -f deploy/Dockerfile -t inucon-portal:local .
docker run -p 3000:3000 inucon-portal:local
```

push 後、GitHub の Package 設定(`https://github.com/users/kisepichu/packages/container/inucon-portal/settings`)で **Package visibility を Public に変更**する。
これにより k3s 側で `imagePullSecret` を用意しなくてよくなる(private のままにする場合は、下記の代わりに `kubectl create secret docker-registry ghcr-pull-secret --docker-server=ghcr.io --docker-username=<user> --docker-password=<PAT> -n inucon` を作成し、`deployment.yaml` の pod spec に `imagePullSecrets: [{name: ghcr-pull-secret}]` を追記すること)。

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

apphost の cloudflared tunnel 設定は **このリポジトリの外**、`nixos-config-private` の `hosts/apphost` にある(Phase 1 の benchvm 向けエントリと同じ形式)。

1. `nixos-config-private` の `hosts/apphost` にある cloudflared ingress 設定(`services.cloudflared` あるいは同等の tunnel config)に、以下のようなエントリを追加する:
   ```nix
   {
     hostname = "inucon.kisen.one";
     service = "http://<k3s Ingress の ClusterIP か Traefik Service の到達先>:80";
   }
   ```
   実際の到達先(Traefik の Service ClusterIP か、`svc/traefik` の NodePort か)は apphost の現行構成を見て決める(k3s 標準の Traefik は `kube-system` namespace の `traefik` Service として存在するはず: `kubectl -n kube-system get svc traefik`)。
2. `nixos-config-private` 側で `nixos-rebuild switch` (apphost 上、または deploy フローに従って)を実行し、cloudflared を再起動する。
3. `nixos-config-private` にも変更 PR を出す(このリポジトリの Task 11 の完了条件の一部)。
4. 確認: `curl -s -o /dev/null -w '%{http_code}\n' https://inucon.kisen.one/api/health` が `200` を返すこと。

## 6. benchvm にランナーを配置(systemd)

ランナー(`runner/`)は benchvm 上に常駐プロセスとして置く。こちらも実体は `nixos-config-private` の `hosts/benchvm` に systemd unit を追加する形になる(このリポジトリには手順のみ記載)。

1. benchvm 上でリポジトリを checkout(または nixos-config-private 側の deploy スクリプトで自動 checkout):
   ```sh
   ssh benchvm.kisen.one   # 実際のホスト名は apphost 同様 cloudflared 経由 or LAN 直結
   git clone https://github.com/kisepichu/inucon.git /opt/inucon   # 既存なら git pull
   cd /opt/inucon
   corepack enable
   pnpm install --frozen-lockfile --prod --filter runner...
   pnpm --filter shared build
   pnpm --filter runner build
   ```
2. `nixos-config-private` の `hosts/benchvm` に systemd service を追加する(agenix で機密を注入):
   ```nix
   systemd.services.inucon-runner = {
     description = "INUCON runner (benchvm)";
     wantedBy = [ "multi-user.target" ];
     after = [ "network-online.target" ];
     environment = {
       PORTAL_URL = "https://inucon.kisen.one";
       # RUNNER_TOKEN は agenix (age.secrets."inucon-runner-token".path) から
       BENCH_DIR = "/home/kise/private-isu/benchmarker";
     };
     serviceConfig = {
       ExecStart = "${pkgs.nodejs_22}/bin/node /opt/inucon/runner/dist/main.js";
       EnvironmentFile = config.age.secrets."inucon-runner-token".path; # RUNNER_TOKEN=...
       Restart = "on-failure";
       RestartSec = "5s";
     };
   };
   ```
   - `agenix` で `runner-token.age` を作成し、中身は `RUNNER_TOKEN=<手順3で決めた値>` の形式(`EnvironmentFile` として読ませる場合。あるいは個別に `Config.redacted` 用の env を組み立てる)。
   - `POLL_INTERVAL_MILLIS` / `PROGRESS_INTERVAL_MILLIS` は既定値(2000ms / 5000ms)のままで問題なければ省略可。
3. `nixos-rebuild switch` で反映し、`systemctl status inucon-runner` で起動確認。
4. 確認: `journalctl -u inucon-runner -f` で poll ログ(job なし時は静かに poll し続ける)が出ていること。実際に `POST /api/bench` でジョブを 1 件 enqueue して、runner ログに実行・進捗・finish が出ることまで確認する。
5. `nixos-config-private` にも変更 PR を出す(Task 11 の完了条件の一部)。

## 7. 動作確認チェックリスト

- [ ] `https://inucon.kisen.one/api/health` が 200
- [ ] `https://inucon.kisen.one/` が SPA を返す
- [ ] GitHub OAuth ログインが成功し、`ADMIN_GITHUB_LOGINS` に含まれるユーザーで管理操作(`/api/admin/contest/start` 等)ができる
- [ ] benchvm の `inucon-runner` が起動し、ポータルへの poll がログで確認できる
- [ ] enqueue → poll → progress → finish → scoreboard 反映が一通り通る(実ベンチ)

## 8. 既知の注意点

- `replicas: 1` 固定(SQLite 単一ファイルのため)。`strategy: Recreate` にしてあるので、デプロイ時は数秒のダウンタイムが出る(身内利用のため許容)
- ランナー→ポータルの経路は `deploy/k8s/service.yaml` の NodePort(`30080`)を暫定で用意しているが、apphost の実ネットワーク構成(LAN からノード IP に到達できるか)を確認してから `PORTAL_URL` を決めること。Ingress 経由(`https://inucon.kisen.one`)でも LAN 内から到達できるなら NodePort は使わなくてもよい
- Secret の値はリポジトリに絶対に入れない(このファイルのコマンド例はすべてプレースホルダ)
