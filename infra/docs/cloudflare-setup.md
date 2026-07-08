# Cloudflare Tunnel + Access 設定 runbook(Phase 1)

実施日: 2026-07-08 (JST)

外部参加者が VPN なしで自分のチームの競技 VM にだけ SSH できる経路を作った。
構成: `inucon-team{N}-{M}.kisen.one` → Cloudflare edge → Tunnel `inucon`(benchvm 上の
cloudflared)→ チーム VM の 22 番。ホスト名ごとの認可は Cloudflare Access。

## 確定値

| 項目 | 値 |
| --- | --- |
| Tunnel 名 / UUID | `inucon` / `0000aaaa-0000-4000-8000-000000000001` |
| zone (kisen.one) | `0000000000000000000000000000a002` |
| account | `0000000000000000000000000000a001` |
| Access アプリ | `inucon team1 ssh` = `0000cccc-...0001`、`inucon team2 ssh` = `0000cccc-...0002` |
| credentials | agenix: nixos-config-private `secrets/cloudflared-inucon.age`(benchvm-host 等 4 鍵宛) |
| API トークン | `infra/.cf-api-token`(gitignore 済み。権限: Tunnel Edit / Access Apps Edit / DNS Edit / Zone Read) |

## 1. トンネル作成(benchvm 上)

```bash
# benchvm (kise@192.0.2.5) で:
nix shell nixpkgs#cloudflared -c cloudflared tunnel login   # ブラウザで kisen.one を Authorize
nix shell nixpkgs#cloudflared -c cloudflared tunnel create inucon
nix shell nixpkgs#cloudflared -c cloudflared tunnel route dns inucon inucon-team1-1.kisen.one
nix shell nixpkgs#cloudflared -c cloudflared tunnel route dns inucon inucon-team2-1.kisen.one
```

注意(ハマりどころ):

- `tunnel login` のブラウザ認証は**発行から数分の待ちウィンドウ内に完了しないと
  `Failed to fetch resource` で失敗する**(3 回失敗した実績あり)。URL を開いたら
  すぐ Authorize し、成功画面まで待つこと。
- `tunnel run` 時の `Cannot determine default origin certificate path` の ERR ログは
  credentials 運転では無害(cert.pem は tunnel の作成・削除にだけ必要)。

## 2. credentials の agenix 化(nixos-config-private)

`~/.cloudflared/<UUID>.json` を `secrets/cloudflared-inucon.age` として暗号化。
recipients は `secrets/secrets.nix` の定義どおり(benchvm-host + ユーザー鍵 3 つ)。

注意: **agenix の `EDITOR="cp <file>"` トリックは空ファイルを生成した**(0 バイトで
暗号化され、cloudflared が Invalid JSON で crash loop)。`age` で直接暗号化する方が確実:

```bash
age -r "<benchvm-host鍵>" -r "<macos鍵>" -r "<desktop鍵>" -r "<redmi鍵>" \
  -o secrets/cloudflared-inucon.age <UUID>.json
```

benchvm 側の NixOS 設定は `hosts/benchvm/configuration.nix` の
`services.cloudflared.tunnels."0000aaaa-..."` を参照(ingress で各チーム VM へ中継)。
デプロイは benchvm に repo を rsync して `sudo nixos-rebuild switch --flake <dir>#benchvm`。

## 3. Access アプリ(API で作成)

ダッシュボード操作を避け、API トークン(`infra/.cf-api-token`)で作成した。
ポリシーは既存の `apphost ssh` アプリと同じ「メール個別許可」方式
(Phase 1 は全チーム = kisepichu@gmail.com)。

```bash
ACC=0000000000000000000000000000a001
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACC/access/apps" \
  -H "Authorization: Bearer $(cat infra/.cf-api-token)" \
  -H "Content-Type: application/json" \
  --data '{
    "name": "inucon team1 ssh (inucon-team1-1)",
    "domain": "inucon-team1-1.kisen.one",
    "type": "self_hosted",
    "session_duration": "24h",
    "policies": [{
      "name": "team1 members", "decision": "allow", "precedence": 1,
      "include": [{"email": {"email": "kisepichu@gmail.com"}}]
    }]
  }'
```

**メンバー追加**(実 ID 込みのコピペ可能な例。team1 に 1 人足す場合):

```bash
ACC=0000000000000000000000000000a001
APP=0000cccc-0000-4000-8000-000000000001           # team1 アプリ(team2: 0000cccc-0000-4000-8000-000000000002)
POL=0000dddd-0000-4000-8000-000000000001           # team1 members(team2: 0000dddd-0000-4000-8000-000000000002)
curl -s -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACC/access/apps/$APP/policies/$POL" \
  -H "Authorization: Bearer $(cat infra/.cf-api-token)" \
  -H "Content-Type: application/json" \
  --data '{
    "name": "team1 members", "decision": "allow", "precedence": 1,
    "include": [
      {"email": {"email": "kisepichu@gmail.com"}},
      {"email": {"email": "<参加者のメール>"}}
    ]
  }'
```

チーム VM 側の SSH 鍵は Terraform の `var.teams.github_users` に GitHub アカウントを
足して apply。

設計メモ:
- スペックでは「GitHub IdP」としていたが、Phase 1 は既存 Zero Trust 組織
  (auth domain: `example.cloudflareaccess.com`)に設定済みのログイン方式 +
  メール許可リストで運用する(既存の `apphost ssh` アプリと同方式。GitHub OAuth App
  の作成というブラウザ作業を避けるため。IdP 追加は開催前に必要になったら実施)
- `cloudflared-inucon.age` の recipients は benchvm-host + ユーザー鍵 3 つの 4 鍵
  (既存 secret 群の apphost-host に相当するのが benchvm-host。apphost はこの secret を
  読む必要がないため recipients に含めていない)

## 4. 参加者の接続方法

`~/.ssh/config` に追加([cloudflared のインストール](https://developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/download-warp/)が必要):

```
Host inucon-*.kisen.one
  ProxyCommand cloudflared access ssh --hostname %h
  User isucon
```

```bash
ssh inucon-team1-1.kisen.one   # 初回はブラウザが開いて Access 認証
```

## 5. 検証結果(2026-07-08)

- `ssh inucon-team1-1.kisen.one` / `ssh inucon-team2-1.kisen.one` とも成功
  (isucon ユーザーで hostname 確認)。2 アプリ目は組織セッションの引き継ぎで
  ブラウザ操作なしに認可された
- Tunnel は Cloudflare edge (nrt) に 4 コネクション登録
- 未認証アクセスの遮断は実測済み: `curl https://inucon-team1-1.kisen.one/` →
  **HTTP 302 で example.cloudflareaccess.com のログインへリダイレクト**(オリジン非到達)
- 「許可リスト外のアカウントでログインした場合の拒否」は Access の default-deny に
  よる設計保証だが、別アカウントでの実測は未実施 — **身内開催の前に必ず一度確認する
  (TODO、Phase 1 クローズ時の申し送り)**
- VPN・家 LAN への到達経路は存在しない(トンネルの ingress は各チーム VM の
  22 番と 404 のみ)
