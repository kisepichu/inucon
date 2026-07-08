# 調査メモ: TypeScript + Effect.ts で DDD を実践するアーキテクチャ選定

日付: 2026-07-09
目的: Phase 2(ポータル)の設計スペック執筆に先立つアーキテクチャ選定の根拠資料。
Web 調査(調査エージェント)の結果をそのまま記録する。

---

## 1. クリーンアーキテクチャ系スタイルの比較

| スタイル | 要点 | 利点 | 欠点 | 小規模 × 関数型との相性 |
|---|---|---|---|---|
| Clean Architecture(4層) | Entities / UseCases / Interface Adapters / Frameworks。依存は内向きのみ | 層ごとの責務が明確、テスト容易、DDD と好相性 | 層・インターフェース・DTO 変換の儀式が多い。1 実装しかない interface が量産されがち | △ 1 人開発では過剰になりやすい |
| Hexagonal(Ports & Adapters) | 中心にビジネスロジック、外側に adapter。層の数は規定しない | 概念が最小(内 / 外 + port だけ)。小〜中規模の「スイートスポット」と評されることが多い | port の粒度設計は自分で決める必要がある | ◎ port = 関数シグネチャ、adapter = 実装関数と自然に対応 |
| Onion | Domain Model を中心に同心円。Clean とほぼ同型 | ドメイン知識が複雑な場合に強い | Clean との差は命名程度で、儀式は同等 | △ |
| Vertical Slice + 軽量 DDD | 機能(ユースケース)単位でディレクトリを切り、層は薄く | 変更が 1 スライスに閉じる。小規模で最速 | 横断的なドメイン不変条件・状態機械が散らばりやすい | ○ ただし「Instance 状態機械」のような共有ドメインが濃い場合は不利 |

各種比較記事の共通見解は「4 パターンは全て DIP(依存性逆転)ベースで本質は同じ。差は儀式の量」であり、小規模ではまず軽く始めて複雑化したら層を足す、が定石([dev.to 比較](https://dev.to/dev_tips/hexagonal-vs-clean-vs-onion-which-one-actually-survives-your-app-in-2026-273f)、[Medium 実践ガイド](https://medium.com/@rup.singh88/stop-confusing-clean-onion-hexagonal-architecture-heres-when-to-use-each-692079e56267)、[Three Dots Labs「Clean Architecture はオーバーエンジニアリングか」](https://threedots.tech/episode/is-clean-architecture-overengineering/))。

## 2. Effect.ts があると層分けはどう簡略化できるか

Effect.ts は `Context.Tag`(サービスのインターフェース宣言)+ `Layer`(実装の注入)で **DIP とコンストラクタ注入を言語機能として内蔵**している。このため古典クリーンの「interface 定義 + DI コンテナ + Adapter 層」の儀式の大半が不要になる。コミュニティの実例:

- **Spiko(本番運用企業)**: `Context.Tag` でサービス(= port)を定義し、`Layer` を合成して本番 / テストを差し替える。「Layer がアーキテクチャの背骨」で、それ以上の層形式は増やしていない([Why We Chose Effect](https://tech.spiko.io/posts/why-we-chose-effect/))
- **hex-effect(Effect 製ヘキサゴナルのリファレンス実装)**: domain / application / infrastructure の **3 層**に集約。application が use case を named function として持ち、infrastructure が in/out adapter([GitHub](https://github.com/jkonowitch/hex-effect))
- **effect-app フレームワーク**: 層は実質 domain / api(application)/ adapter の 3 つ。**Schema を単一の情報源**にして、ドメインモデル・DB スキーマ・API 入出力を全部導出する思想([effect-app/docs](https://github.com/effect-app/docs))

まとめ: Effect コミュニティの現代的な簡略化は **「Interface Adapters 層を消して 3 層にする」+「port は Context.Tag、adapter は Layer」+「DTO 変換は Schema の encode/decode に吸収」**。

## 3. 関数型 DDD のパターン(Wlaschin 系 + Effect Schema)

Scott Wlaschin『Domain Modeling Made Functional』流の型駆動 DDD は TypeScript に素直に移植できる([Bespoyasov の書評 + TS 翻訳例](https://bespoyasov.me/blog/domain-modelling-made-functional/)、[Khalil Stemmler「Make Illegal States Unrepresentable」](https://khalilstemmler.com/articles/typescript-domain-driven-design/make-illegal-states-unrepresentable/))。Effect 公式系の [Effect Solutions: Data Modeling](https://www.effect.solutions/data-modeling) が推奨する具体形:

- **ブランド型をほぼ全プリミティブに**: `TeamId`, `InstanceId` を `Schema.String.pipe(Schema.brand("TeamId"))` で区別
- **集約 = Schema.Class(イミュータブルなデータ)+ 純粋な状態遷移関数**。状態は `Schema.TaggedClass` + `Schema.Union` の直和型で表し、`Match.value` で網羅チェック
- 状態機械(Instance の creating→running→deleting、BenchJob の pending→running→done/failed)は **状態ごとの型 + `(state, event) => Either<Error, NewState>` の遷移関数**で「不正遷移を型で表現不能」にする
- 実践記事([Thomas Dupont: DDD and FP with Effect](https://medium.com/@setni/domain-driven-design-and-functional-programming-with-effect-440686b51d5e))も同じ構成: エンティティは Schema 製 plain data、ビジネスルールは policy 関数、検証は境界(repository 出口)で実施

## 4. Effect でのリポジトリパターンと「ドメイン層は Effect 依存か」論争

**典型形**: `Context.Tag`(または `Effect.Service`)で port を宣言 → `@effect/sql` を使う `Layer.effect` で実装 → main で合成。テストはインメモリ Layer に差し替え([Effect 公式 Services](https://effect.website/docs/requirements-management/services/) / [Layers](https://effect.website/docs/requirements-management/layers/)、[Effect エコシステムでの API 構築例](https://dev.to/martinpersson/building-robust-typescript-apis-with-the-effect-ecosystem-1m7c))。

```ts
class BenchJobRepo extends Context.Tag("BenchJobRepo")<BenchJobRepo, {
  readonly dequeueOldestPending: Effect.Effect<Option<BenchJob>, DbError>
}>() {}
// 実装: Layer.effect(BenchJobRepo, Effect.gen(... yield* SqlClient ...))
```

**ドメイン層の Effect 依存については二派**:

- **純粋 TS 派**: 集約・遷移関数は Effect 非依存(戻り値はせいぜい `Either`)にし、Effect は application / infrastructure だけで使う。移植性と学習コストの低さが根拠(Dupont 記事、[Harbor「なぜ Effect を使わないか」](https://runharbor.com/blog/2025-11-24-why-we-dont-use-effect-ts) が学習コスト面を指摘)
- **全面 Effect 派**(hex-effect、effect-app、Spiko): ドメインでも Schema/Either/Effect の語彙を使う。Schema 自体がドメインモデリング言語であり、エラー・依存が型に現れる利点を優先

実務的な折衷は「**データ定義は Effect Schema(これはドメイン層に置いてよい)、状態遷移は純粋関数で `Either` を返す、I/O を伴うものだけ `Effect` 型**」。Effect Schema はほぼデータ定義 DSL なので「Effect 依存」の重さは runtime 依存とは別物、というのがコミュニティの大勢。

## 5. 参考 OSS リポジトリ

1. **[jkonowitch/hex-effect](https://github.com/jkonowitch/hex-effect)**(Effect 使用・最重要): ヘキサゴナル × DDD のリファレンス。domain/application/infrastructure の 3 層、use case を @effect/rpc で公開、ドメインイベント連携まで実装
2. **[effect-app](https://github.com/effect-app/docs)**: Schema 単一情報源(ドメイン・DB・API・フォームを 1 スキーマから導出)、`_etag` による楽観ロック、リポジトリ抽象の Layer 差し替え
3. **[Sairyss/domain-driven-hexagon](https://github.com/Sairyss/domain-driven-hexagon)**(TS 一般・スター多数): DDD × ヘキサゴナルの教科書的リポジトリ。層責務・命名・フォルダ構成のドキュメントが充実しており docs 執筆の雛形に最適
4. **[PaulJPhilp/EffectPatterns](https://github.com/PaulJPhilp/EffectPatterns)**: Effect のパターン集(サービス定義、Layer 合成、エラー設計)
5. **[yerinadler/typescript-ddd-sample-app](https://github.com/yerinadler/typescript-ddd-sample-app)**: TS の古典的 DDD 実装(比較対象)

## 6. ISUCON ポータル系のジョブキュー設計(piscon-portal-v2 中心)

**[traPtitech/piscon-portal-v2](https://github.com/traPtitech/piscon-portal-v2)**(Go)は本プロジェクトとドメインがほぼ同一(Team / Instance(AWS or Docker)/ BenchJob / runner)で、層構成は:

```
server/
  domain/      # エンティティと契約
  usecase/     # アプリケーションオーケストレーション
  repository/  # 永続化
  services/    # 外部サービス統合(インスタンス管理等)
  handler/     # HTTP(ogen で OpenAPI 生成)
```

つまり **handler → usecase → repository/services → domain の実用的 4 層クリーン**で、コード生成(OpenAPI: ogen、DB: bobgen)を多用。runner は独立プロセスで、`portal.GetJob(ctx)` で **ポータルからジョブを 1 件取得 → ベンチ実行 → 5 秒間隔で進捗(スコア + stdout/stderr)をストリーム送信 → `PostJobFinished` で完了報告**という単純な pull 型。本家 [isucon/portal](https://github.com/isucon/portal) 系も同様に DB をキューにした pull 型(queue.go / jobhandler.go)。

**設計として持ち帰るべき点**:
1. キューは DB テーブル + `status` カラムで十分(FIFO は `ORDER BY created_at`、取得は `UPDATE ... WHERE status='pending'` のアトミック dequeue)
2. ランナーは stateless な HTTP ポーリングにして portal 側を単純化
3. 進捗報告 API を最初から分けておく(実行中スコアの表示は競技体験上重要)
4. ジョブ状態遷移はドメインの状態機械としてモデリングし、handler ではなく usecase/domain で遷移検証

---

## このプロジェクトへの推奨アーキテクチャ

### 3 案の比較

| 観点 | **A. 軽量ヘキサゴナル 3 層(Effect ネイティブ)** | B. 古典クリーン 4 層 | C. Vertical Slice + 軽量 DDD |
|---|---|---|---|
| 層 | domain / application(use case)/ infrastructure(adapter) | entities / usecases / adapters / frameworks | feature ごと(contest/, team/, instance/, benchjob/) |
| port の表現 | `Context.Tag` | interface + DI(結局 Tag で再発明) | 各 slice 内に直書き or Tag |
| Effect との整合 | ◎ Layer/Tag がそのまま port/adapter | △ Adapter 層と Schema の encode/decode が二重化 | ○ |
| 状態機械(Instance/BenchJob)の置き場 | domain に集約、純粋遷移関数 | domain に集約 | slice を跨ぐ共有が発生し崩れやすい |
| docs の書きやすさ | ◎ 層 = 3 概念で説明が短い | ○ だが儀式の説明が長い | △ 横断ドメインの記述が分散 |
| 1 人 + AI エージェント開発 | ◎ ファイル数最小、AI に規約を伝えやすい | △ ボイラープレート量産 | ○ |
| 将来の拡張(通知、別 DB 等) | ○ adapter 追加で対応 | ◎ | △ |

### 推奨: A. 軽量ヘキサゴナル 3 層(Effect ネイティブ)

**根拠**:
1. **Effect が Clean の第 3 層(Interface Adapters)を言語機能で肩代わりする**ため、4 層にする意味がほぼない。hex-effect・effect-app・Spiko という Effect コミュニティの主要実例がすべて実質 3 層に収斂している
2. 本プロジェクトの複雑さの核は **Instance / BenchJob の状態機械という「濃いドメイン」**であり、これは vertical slice より「domain を中心に置く」ヘキサゴナルが守りやすい。piscon-portal-v2(同ドメインの先行 Go 実装)も domain 中心の層構成を採っている
3. テーブル 10 個以下・開発者 1 人では、Clean 4 層の儀式(DTO 変換、1 実装 interface)は投資対効果が合わないというのが比較記事群の一致した見解

**具体構成の指針**:

```
src/
  domain/        # Effect Schema(ブランド型・TaggedClass の状態直和型)+ 純粋遷移関数(Either 返し)
  application/   # use case = Effect.gen 関数。port(Context.Tag): BenchJobRepo, InstanceManager, Clock...
  infrastructure/# @effect/sql-sqlite 実装 Layer、GitHub OAuth adapter、HTTP(@effect/platform)
  main.ts        # Layer 合成
```

- ドメインは「データ定義に Schema は使うが runtime の Effect 型は使わない(Either まで)」の折衷を推奨 — テストが `expect(transition(s, e))` で書け、AI エージェントにも生成させやすい
- BenchJob キューは DB FIFO + `pending` 行のアトミック更新、runner は piscon-portal-v2 と同じ pull 型 HTTP ポーリング + 進捗報告エンドポイント
- docs は Sairyss/domain-driven-hexagon の README 構成(層責務 → ユビキタス言語 → 状態機械図)を雛形にすると DDD ドキュメントとして体裁が整う

次点は C(vertical slice)だが、Instance/BenchJob の状態機械が複数機能から参照される時点で共有ドメイン層が必要になり、結局 A に近づくため、最初から A を選ぶのが素直。

**主要ソース**: [hex-effect](https://github.com/jkonowitch/hex-effect) / [effect-app docs](https://github.com/effect-app/docs) / [Spiko: Why We Chose Effect](https://tech.spiko.io/posts/why-we-chose-effect/) / [Effect Solutions: Data Modeling](https://www.effect.solutions/data-modeling) / [Effect 公式: Services](https://effect.website/docs/requirements-management/services/)・[Layers](https://effect.website/docs/requirements-management/layers/) / [DDD and FP with Effect (Dupont)](https://medium.com/@setni/domain-driven-design-and-functional-programming-with-effect-440686b51d5e) / [Domain Modelling Made Functional 書評](https://bespoyasov.me/blog/domain-modelling-made-functional/) / [Sairyss/domain-driven-hexagon](https://github.com/Sairyss/domain-driven-hexagon) / [traPtitech/piscon-portal-v2](https://github.com/traPtitech/piscon-portal-v2) / [isucon/portal](https://github.com/isucon/portal) / [アーキテクチャ比較 (dev.to)](https://dev.to/dev_tips/hexagonal-vs-clean-vs-onion-which-one-actually-survives-your-app-in-2026-273f) / [Three Dots Labs](https://threedots.tech/episode/is-clean-architecture-overengineering/) / [Harbor: Why We Don't Use Effect-TS](https://runharbor.com/blog/2025-11-24-why-we-dont-use-effect-ts)
