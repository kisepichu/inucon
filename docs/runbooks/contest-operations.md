# コンテスト運営手順(runbook)

INUCON 開催の前日〜当日〜終了後の作業。デプロイ自体は `deploy/README.md` を参照。
操作の主体: 「Admin UI」= https://inucon.kisen.one の Admin ページ(`ADMIN_GITHUB_LOGINS`
のユーザーでログイン)。

## コンテストの状態機械(前提知識)

`preparing → running → finished` の**一方向**(`portal/src/domain/contest.ts`)。

- ベンチ実行(enqueue)は **running のみ**可(`ContestNotRunning` で拒否)。
- インスタンスの追加/削除・招待は状態に依らず可能(事前払い出しを許す設計)。
- Scoreboard は常時表示。
- **リセット遷移は無い**。同じ DB で 2 回目のコンテストを開催するには DB 作業が要る
  (下記「次回開催に向けて」)。contest 行は seed(新規 DB 起動時)が
  `INUCON / private-isu / preparing / quota 3` を 1 行作る。

## 開催前(前日まで)

1. **デプロイ確認**: 本番が main と同一か。`/api/health` 200。
2. **ランナー確認**(benchvm): `systemctl status inucon-runner` が active、
   `journalctl -u inucon-runner -f` で poll が回っている。benchvm の IP は DHCP で変動
   するため、ポータル側 `PORTAL_URL` 到達性も含めて 1 度ベンチを通しで確認しておく。
3. **チーム作成**(Admin UI): チーム名 + チーム番号(1-254)。
4. **メンバー招待**(Admin UI → 招待): githubLogin + **Access ログイン用 email**。
   - 未ログインのメンバーは「招待作成(pending)」になり、初回 GitHub ログイン時に
     自動でチームに入る。
   - 結果カードの warnings(email 未登録で Access に載らなかった等)を必ず確認。
5. **インスタンス払い出し**: 各チームの Team ページから追加(メンバー自身でも可)。
   quota はコンテスト行の `instance_quota`(既定 3)。eevee の空きメモリが閾値
   (既定 5GB)未満だと `InsufficientMemory` で弾かれる。
   - 目安: VM 1台 4GiB。KSM がクローン間の同一ページを統合するため、起動から数分で
     実効使用量は下がる(直後に閾値割れでも回復し得る)。
6. **SSH 開通確認**: 各メンバーが `ssh isucon@inucon-team{N}-{M}.kisen.one` で入れること
   (Cloudflare Access のメール認証 → 鍵認証)。招待した email 以外では認証メールが
   届かないこと(deny)も 1 アカウントで確認しておくと確実。
7. **リハーサル**: どこかのチームでベンチを 1 回実行し、スコアが Scoreboard に出る
   ところまで通す。

## 開始時

1. Admin UI → コンテスト → **「開始」**(preparing → running)。
2. 確認: Team ページからベンチが enqueue でき、runner が拾って finished になること。

競技中の監視(必要に応じて):

```sh
# ポータルのログ
ssh apphost.kisen.one 'kubectl -n inucon logs deploy/inucon-portal -f --tail=50'
# ランナーのログ(benchvm)
ssh kise@<benchvm-ip> 'journalctl -u inucon-runner -f'
# eevee の負荷/メモリは WebUI(https://192.0.2.10:8006)
```

- ベンチはグローバル直列(同時 1 本)。詰まって見えるときはジョブ一覧の queued 数と
  runner ログを確認。ジョブは `JOB_TIMEOUT_MILLIS`(既定 10 分)で自動 fail 回収される。
- インスタンスが `failed` になった場合: エラー内容を確認 → そのインスタンスは
  チーム自身(or admin)が削除すれば片付く(補償 saga が実 VM/CF リソースを掃除する)。

## 終了時

1. Admin UI → コンテスト → **「終了」**(running → finished)。
   以降ベンチは enqueue できない(実行中のジョブは完走 or タイムアウト回収)。
2. 結果の記録: Scoreboard を確認・保存(必要ならスクリーンショット、または
   `GET /api/scoreboard` の JSON を保存)。
3. **注意**: finished にしてもチーム VM への SSH アクセスは遮断されない
   (アクセス遮断の仕組みは未実装 = 今後対応として記録済み)。講評期間など
   アクセスを残したい場合はそのままで良い。

## 後片付け(結果確定後)

1. **セルフサービス製インスタンスの削除**: 各チームの Team ページ(or admin)から削除。
   teardown が VM 停止/破棄・CF ルート・Access アプリまで掃除する。
   チーム内の削除は 1 台ずつ直列(進行中 1 本ガード)。
2. **terraform 製 VM**(Phase 1 で作った分)はポータルから消さず、`infra/` の
   `terraform destroy`(または該当リソースの削除)で片付ける。台帳と実体の管理者が
   異なるため混ぜない。
3. **DB バックアップ**: `deploy/README.md` のスナップショット手順で結果込みの DB を
   保存しておく。

## 次回開催に向けて(現状の制約)

contest は 1 行・一方向遷移のため、同じ DB で次回を開催するには手作業が要る:

- スコア/ジョブ履歴を持ち越さない場合: DB バックアップを取った上で、
  pod を止めて PVC の `portal.db` を消して起動し直す(seed が preparing の contest を
  作り直す。ユーザー/チームも消えるため再招待が必要)。
- 持ち越したい場合: contest 行の status を SQL で preparing に戻す等の直接更新に
  なる(状態機械の外の操作なので、必要になった時点でツール化を検討)。

このあたりの「第2回」体験(コンテスト複数回、アーカイブ)は未設計。開催が見えたら
仕様化する。
