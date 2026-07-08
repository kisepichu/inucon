#!/usr/bin/env bash
# eevee 上で実行する。ビルド中の private-isu 問題 VM (vmid 9100) に対し、
# private-isu ベンチ失敗の恒久修正パッチを nginx 設定へ適用する。
# build-template.sh の後、finalize-template.sh の前に実行すること
# (build → patch → 検証 → finalize)。
#
# 根本原因(詳細: .superpowers/sdd/task-7-debug.md):
#   Go net/http のリダイレクト追従は同一ホスト内では POST の Content-Type
#   ヘッダをボディの無い GET にもそのまま引き継ぎ、Rack 3.2.6 の
#   Request#form_data? が HTTP メソッドを見ず Content-Type の値だけで
#   multipart 判定するため、ベンチのリダイレクト追従 GET が
#   Rack::Multipart::EmptyContentError -> Sinatra 400 Bad Request を踏む。
#
# 対応: nginx リバースプロキシ層で GET/HEAD リクエストのみ upstream
# (Unicorn) へ渡す Content-Type ヘッダを空にする。POST 等ボディを伴う
# リクエストには一切影響しない。
#
# matsuu 由来の user-data.build.yaml(private-isu の ansible provisioning)は
# 原本無改変ポリシーのため変更しない。本スクリプトはビルドフローの
# 独立ステップとして nginx 設定ファイルを直接書き換える。冪等
# (何度実行しても同じ結果になる。二重適用してもエラーにならない)。
set -euxo pipefail

VMID=9100

qm status "$VMID" &>/dev/null || { echo "vmid $VMID が存在しない" >&2; exit 1; }

# ゲスト内で実行するスクリプト本体。'GUEST_EOF' でクォートしているため、
# ここでは $ を含む変数・nginx 変数は一切展開されず、そのままゲストへ渡る。
read -r -d '' GUEST_SCRIPT <<'GUEST_EOF' || true
set -euxo pipefail
CONF_D=/etc/nginx/conf.d/strip-get-content-type.conf
# sites-enabled/isucon.conf は sites-available/isucon.conf への symlink(同一実体、実機確認済み)
SITE_CONF=/etc/nginx/sites-available/isucon.conf

# GET/HEAD の Content-Type を空にする map(新規ファイル。上書きなので冪等)。
cat > "$CONF_D" <<'NGINX_MAP'
# 恒久修正(詳細: .superpowers/sdd/task-7-debug.md)
# 根本原因: Go net/http のリダイレクト追従が同一ホスト内では GET にも
# 直前 POST の Content-Type を引き継ぎ、Rack 3.2.6 の form_data? が
# メソッドを見ず Content-Type だけで multipart 判定するため 400 になる。
map $request_method $upstream_content_type {
    default $http_content_type;
    GET     "";
    HEAD    "";
}
NGINX_MAP

# site conf への1行挿入は二重適用ガード付き(grep で既存チェック)。
if ! grep -q 'upstream_content_type' "$SITE_CONF"; then
  sed -i '/proxy_set_header Host \$host;/a\    proxy_set_header Content-Type $upstream_content_type;' "$SITE_CONF"
fi
# sed はアンカー行が見つからなくても黙って成功するため、挿入結果を必ず検証する
grep -q 'upstream_content_type' "$SITE_CONF" || {
  echo "FATAL: $SITE_CONF への proxy_set_header 挿入に失敗(アンカー行の書式変更?)" >&2
  exit 1
}

nginx -t
systemctl reload nginx

echo "---- $CONF_D ----"
cat "$CONF_D"
echo "---- $SITE_CONF (location /) ----"
grep -A4 'location / {' "$SITE_CONF"
GUEST_EOF

B64=$(printf '%s' "$GUEST_SCRIPT" | base64 -w0)
qm guest exec "$VMID" --timeout 60 -- bash -c "echo $B64 | base64 -d | bash -s"

echo "patch-app.sh: 適用完了 (vmid $VMID)"
echo "効果確認の例:"
echo '  curl -s -o /dev/null -w "%{http_code}\n" http://<VMのIP>/'
echo '  curl -s -o /dev/null -w "%{http_code}\n" -H "Content-Type: multipart/form-data; boundary=x" http://<VMのIP>/posts/1  # -> 200 (パッチ前は 400)'
