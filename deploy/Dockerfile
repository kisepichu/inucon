# INUCON portal イメージ(deploy/README.md にビルド/デプロイ手順あり)。
#
# ビルドコンテキストはリポジトリルート(`docker build -f deploy/Dockerfile .`)。
# pnpm workspace(shared/portal/portal/web/runner)のうち、portal の実行に
# 必要な部分だけを実行ステージに残す multi-stage 構成。
#
# shared パッケージの exports は開発時(`development` カスタム条件)は
# src/*.ts を直接指し、それ以外(= このイメージのようにプレーンな `node` で
# 実行する場合)は `default` 条件で dist/*.js を指す(tsconfig.base.json の
# customConditions と対になっている)。そのため実行ステージに入る前に
# 必ず `pnpm --filter shared build` を通す必要がある。
#
# better-sqlite3 のネイティブアドオンは glibc/Node ABI に依存するため、
# ビルドステージ・実行ステージともに同一の node:22-slim(Debian/glibc)を
# 使うことで整合させている。
#
# `--trust-lockfile`: pnpm 11 のサプライチェーン検証(minimumReleaseAge 等)
# を pnpm-lock.yaml の全エントリに対して再適用するステップをスキップする。
# このリポジトリの pnpm-lock.yaml は自前で生成・コミットしたもの(信頼済み
# ベース)であり、CI/Docker ビルドで「公開直後のパッケージ」扱いで弾かれる
# 誤検知を避けるために付与している。

ARG NODE_IMAGE=node:22-slim

FROM ${NODE_IMAGE} AS base
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate
WORKDIR /app

# --- 依存関係インストール(dev 込み、ビルド用) -------------------------
FROM base AS deps
# better-sqlite3 は prebuild-install で prebuilt バイナリを取得するが、
# 取得できない環境向けのフォールバック(node-gyp)用に最低限のビルド
# ツールチェーンを入れておく。
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY shared/package.json shared/package.json
COPY portal/package.json portal/package.json
COPY portal/web/package.json portal/web/package.json
COPY runner/package.json runner/package.json
RUN pnpm install --frozen-lockfile --trust-lockfile

# --- ビルド(shared → web → portal の順。Task 1 の outDir=dist と整合) ---
FROM deps AS build
COPY tsconfig.base.json ./
COPY shared shared
COPY portal portal
RUN pnpm --filter shared build \
  && pnpm --filter web build \
  && pnpm --filter portal build

# --- 本番依存のみインストール(portal とその依存(shared含む)のみに絞る) ---
FROM base AS prod-deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY shared/package.json shared/package.json
COPY portal/package.json portal/package.json
COPY portal/web/package.json portal/web/package.json
COPY runner/package.json runner/package.json
RUN pnpm install --frozen-lockfile --trust-lockfile --prod --filter portal...

# --- 実行ステージ: 本番 node_modules + ビルド成果物のみ ------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

# pnpm の node_modules は各パッケージ配下にシンボリックリンクを張る構成
# (中身の実体は /app/node_modules/.pnpm)なので、ディレクトリ構造を
# ビルド時と揃えたまま丸ごとコピーする。
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/shared/package.json ./shared/package.json
COPY --from=prod-deps /app/shared/node_modules ./shared/node_modules
COPY --from=prod-deps /app/portal/package.json ./portal/package.json
COPY --from=prod-deps /app/portal/node_modules ./portal/node_modules

COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/portal/dist ./portal/dist
COPY --from=build /app/portal/web/dist ./portal/web/dist

# DB_PATH 未指定時の既定値(data/portal.db)を保存するディレクトリ。
# k8s では PVC が /data にマウントされるため、このディレクトリは作成のみ。
RUN mkdir -p /app/data

EXPOSE 3000

# 非 root で実行する(k8s では deployment.yaml に securityContext.fsGroup を設定)
USER node

CMD ["node", "portal/dist/main.js"]
