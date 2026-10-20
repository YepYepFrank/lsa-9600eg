#!/bin/bash
# 一键安装 setup.sh 子站升级「留旧版 + 清旧镜像」回归（0.18.1）：sp_keep_old / sp_pre_upgrade_model / sp_prune_app_images。
# 在一次性容器里跑，docker / df 是替身（不碰真的 Docker），子站目录是造的：
#   bash deploy/test/setup-old-test.sh
set -euo pipefail
export MSYS_NO_PATHCONV=1
ROOT="$(cd "$(dirname "$0")/../.." && (pwd -W 2>/dev/null || pwd))"
docker run --rm --pull never -i -v "$ROOT/deploy:/d:ro" --entrypoint bash ubuntu:24.04 -s <<'EOS'
set -uo pipefail
fail=0; n=0
ok() { n=$((n+1)); echo "  ✓ $*"; }
bad() { n=$((n+1)); echo "  ✗ $*"; fail=1; }
W=$(mktemp -d); mkdir -p "$W/bin"
# docker 替身：镜像清单在 /tmp/imgs（一行一个 tag），在用的在 /tmp/used（tag → 容器名）；rm 记到 /tmp/rm.log
cat > "$W/bin/docker" <<'EOF'
#!/bin/bash
case "$1 $2" in
  "image ls") sed 's#^#lsa9600sp/app:#' /tmp/imgs ;;
  "image inspect")
    img="${@: -1}"; tag="${img#*:}"
    grep -qx "$tag" /tmp/imgs || exit 1
    case "$*" in *'.Id'*) echo "sha:$tag" ;; *'.Size'*) echo 1073741824 ;; esac ;;
  "ps -a") f="$*"; tag="${f#*ancestor=sha:}"; tag="${tag%% *}"; awk -v t="$tag" '$1 == t { print $2 }' /tmp/used ;;
  "image rm") tag="${3#*:}"; echo "$tag" >> /tmp/rm.log; sed -i "/^$(printf %s "$tag" | sed 's/\./\\./g')\$/d" /tmp/imgs ;;
esac
exit 0
EOF
# df 替身：剩余（KB）按 /tmp/free
printf '#!/bin/sh\necho "Filesystem 1K-blocks Used Available Use%% Mounted"\necho "x 0 0 $(cat /tmp/free) 0%% /"\n' > "$W/bin/df"
chmod +x "$W/bin/"*; export PATH="$W/bin:$PATH"
SRC=/d/bundle/setup.sh
{ sed -n '/^say() {/p;/^die() {/p;/^envget() {/p' "$SRC"
  for fn in sp_keep_old sp_pre_upgrade_model sp_prune_app_images; do awk "/^${fn}\\(\\) \\{/,/^\\}/" "$SRC"; done; } > "$W/fn.sh"
. "$W/fn.sh"
SP_DEST="$W/opt"; SP_B="$SP_DEST/lsa9600sp-backend"; SP_ENV="$SP_B/docker/.env"
mk_sp() {  # $1 = 现在装着的版本
  rm -rf "$SP_DEST"; mkdir -p "$SP_B/docker" "$SP_B/tb" "$SP_B/scripts"
  echo "APP_VERSION=$1" > "$SP_ENV"; echo 'station: 现场改过' > "$SP_B/tb/model.yaml"; echo '#!/bin/sh' > "$SP_B/scripts/rollback.sh"
}
echo 999999999 > /tmp/free; : > /tmp/used; : > /tmp/rm.log

echo "== 1. 0.18.0 → 0.18.1：留 .old、留升级前的 model.yaml"
mk_sp 0.18.0
out="$(sp_keep_old 0.18.1 2>&1)"; rc=$?
[ "$rc" = 0 ] && [ "$(envget "$SP_B.old/docker/.env" APP_VERSION)" = 0.18.0 ] && ok ".old 是 0.18.0 的整份目录" || bad "rc $rc：$out"
grep -q '旧版（0.18.0）留在' <<<"$out" && ok "说了旧版留在哪、用 rollback.sh" || bad "$out"
grep -q '本机没有旧版镜像 lsa9600sp/app:0.18.0' <<<"$out" && ok "镜像不在时提示（不拦）" || bad "没提示镜像：$out"
out="$(sp_pre_upgrade_model)"; [ -f "$SP_B/tb/model.yaml.pre-upgrade" ] && ok "tb/model.yaml.pre-upgrade 留了" || bad "$out"
[ ! -e "$SP_B.old.tmp" ] && ok "没有残留 .old.tmp" || bad "残留 .old.tmp"

echo "== 2. 同一版本 0.18.1 重跑：.old 不动"
echo 'APP_VERSION=0.18.1' > "$SP_ENV"
out="$(sp_keep_old 0.18.1)"
[ "$(envget "$SP_B.old/docker/.env" APP_VERSION)" = 0.18.0 ] && grep -q '同一版本（0.18.1）重跑' <<<"$out" && ok ".old 还是 0.18.0" || bad "$out"

echo "== 3. 再升 0.18.1 → 0.18.2：.old 换成 0.18.1"
echo '0.18.1' > /tmp/imgs
out="$(sp_keep_old 0.18.2)"
[ "$(envget "$SP_B.old/docker/.env" APP_VERSION)" = 0.18.1 ] && ! grep -q '本机没有旧版镜像' <<<"$out" && ok ".old = 0.18.1、旧镜像在就不提示" || bad "$out"

echo "== 4. 空间不够：覆盖之前停下，什么都没改"
mk_sp 0.18.0; rm -rf "$SP_B.old"; echo 1000 > /tmp/free
out="$( (sp_keep_old 0.18.1) 2>&1)"; rc=$?
[ "$rc" != 0 ] && grep -q '只剩 0 MB' <<<"$out" && [ ! -e "$SP_B.old" ] && [ ! -e "$SP_B.old.tmp" ] && ok "rc $rc 停下、没留半截（$(grep -o '留旧版目录要约 [0-9]* MB' <<<"$out")）" || bad "rc $rc：$out"
echo 999999999 > /tmp/free

echo "== 5. 已有本站模型（model.station.yaml）：不留 pre-upgrade"
mk_sp 0.18.1; echo x > "$SP_B/tb/model.station.yaml"; sp_pre_upgrade_model >/dev/null
[ ! -e "$SP_B/tb/model.yaml.pre-upgrade" ] && ok "没留" || bad "留了"

echo "== 6. 清旧镜像：留现在的 + .old 的；有容器在用的不删"
mk_sp 0.18.1; mkdir -p "$SP_B.old/docker"; echo 'APP_VERSION=0.18.0' > "$SP_B.old/docker/.env"
printf '0.16.0\n0.17.3\n0.17.4\n0.18.0\n0.18.1\n' > /tmp/imgs; printf '0.17.3 lsa-plat-ext\n' > /tmp/used; : > /tmp/rm.log
out="$(sp_prune_app_images)"
[ "$(sort /tmp/rm.log | tr '\n' ' ')" = "0.16.0 0.17.4 " ] && ok "删了 0.16.0、0.17.4" || bad "删了：$(cat /tmp/rm.log)"
[ "$(sort /tmp/imgs | tr '\n' ' ')" = "0.17.3 0.18.0 0.18.1 " ] && ok "留着 0.18.1（现在）、0.18.0（.old）、0.17.3（平台在用）" || bad "剩：$(cat /tmp/imgs)"
grep -q '留着 lsa9600sp/app:0.17.3：还有容器在用（lsa-plat-ext）' <<<"$out" && ok "在用的打了一行说明" || bad "$out"
grep -q '清掉旧的子站镜像 lsa9600sp/app：0.16.0 0.17.4（约 2048 MB）' <<<"$out" && ok "打了删哪几个、腾出多少" || bad "$out"
: > /tmp/rm.log; out="$(sp_prune_app_images)"
[ ! -s /tmp/rm.log ] && grep -q '没有要清的（有容器在用的没删：0.17.3）' <<<"$out" && ok "再跑一次：没有要清的" || bad "$out"

echo "== 7. 新装（没有 .old）：只留现在的"
mk_sp 0.18.1; printf '0.18.0\n0.18.1\n' > /tmp/imgs; : > /tmp/used; : > /tmp/rm.log
out="$(sp_prune_app_images)"
[ "$(cat /tmp/rm.log)" = 0.18.0 ] && ok "删了 0.18.0（没有 .old 要它）" || bad "删了：$(cat /tmp/rm.log)；$out"

echo
[ "$fail" = 0 ] && echo "== 通过（$n 项）" || { echo "== 有失败项"; exit 1; }
EOS
