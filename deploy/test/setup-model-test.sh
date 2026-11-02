#!/bin/bash
# 一键安装 setup.sh --role sp --model <本站模型.yaml>：原样（转成绝对路径）透传给子站 scripts/up.sh --prod --model（后端 #228）。
# 起因：紫蓬山 0.19.4 先用包内样板模型 provision，单元序号按样板记进 model.site.yaml，之后放本站模型 EG 地址排错（.48–.67，应 .11–.30）。
#
#   bash deploy/test/setup-model-test.sh            （开发机 Git Bash，Docker 起着；用本机已有的 ubuntu:24.04，不下载）
#
# 一次性容器里放一个假一键包（真 setup.sh / stub.sh，假子站：up.sh 只记参数并照 --model 拷 tb/model.station.yaml；
# docker 用一个什么都成功的假命令），查：
#   --role eg --model → 拒；文件不在 / 空 / 没有 cabinets: / 包里的 up.sh 不认 --model → 拒，且 /opt/lsa9600sp 没出现（什么都没动）
#   直接跑 setup.sh、在别的目录给相对路径 → up.sh 收到 --prod --model <绝对路径>，tb/model.station.yaml 与给的一致（首次安装）
#   经 .run（stub 解到 /var/tmp 再调 setup.sh）给 --model=<相对路径> → 同上（升级路径）
#   不给 --model → up.sh 只收到 --prod
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export MSYS_NO_PATHCONV=1
D=lsa-setup-model
docker rm -f "$D" >/dev/null 2>&1 || true
docker run -d --pull never --name "$D" -v "$(cd "$ROOT/deploy" && (pwd -W 2>/dev/null || pwd)):/deploy:ro" ubuntu:24.04 sleep infinity >/dev/null || exit 1
trap 'docker rm -f "$D" >/dev/null 2>&1' EXIT
docker exec -i "$D" bash -s <<'IN'
set -uo pipefail
n_ok=0; fail=0
ok() { echo "  ✓ $*"; n_ok=$((n_ok + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }

# 假 docker：什么都成功（load 吃掉标准输入）
cat > /usr/local/bin/docker <<'EOF'
#!/bin/sh
case "$1" in
  compose) [ "${3:-}" = --short ] && echo 2.29.0; exit 0 ;;
  version) echo 27.0.0; exit 0 ;;
  load) cat > /dev/null; echo 'Loaded image: lsa9600sp/app:0.0.0-test'; exit 0 ;;
  *) exit 0 ;;
esac
EOF
chmod +x /usr/local/bin/docker

# 假一键包 /w/b/lsa9600sp-bundle（.run 负载里就是这个目录名）
B=/w/b/lsa9600sp-bundle
S="$B/sp/lsa9600sp-backend"
mkdir -p "$S/scripts" "$S/docker" "$S/tb" "$B/sp/web" "$B/docs"
sed 's/\r$//' /deploy/bundle/setup.sh > "$B/setup.sh"
echo '0.0.0-test' > "$B/VERSION"
echo 'x' | gzip > "$B/sp/images.tar.gz"
echo '<html></html>' > "$B/sp/web/index.html"
cat > "$S/docker/.env.prod.example" <<'EOF'
APP_VERSION=0.0.0-test
SP_HOST_IP=
SP_TLS_SAN=
PG_PASSWORD=x
TB_TENANT_USER=tenant@lsa
TB_TENANT_PASSWORD=x
TB_SYSADMIN_USER=sysadmin@thingsboard.org
TB_SYSADMIN_PASSWORD=sysadmin
TB_HTTP_PORT=8080
EXT_SEED_PASSWORD=x
SCREEN_PASSWORD=x
EXT_JWT_SECRET=x
WEB_ROOT=
BACKUP_DIR=
EOF
# 假 up.sh：记参数；照 --model 拷成 tb/model.station.yaml（rotate_sysadmin：让 setup.sh 不去登 TB）
cat > "$S/scripts/up.sh" <<'EOF'
#!/bin/bash
# 假子站 up.sh（--model、rotate_sysadmin）
R="$(cd "$(dirname "$0")/.." && pwd)"
echo "$*" > /w/up-args
# 真 up.sh 首次会生成站内 CA：升级时 setup.sh 要核它前后一致
mkdir -p "$R/docker/tls" "$R/docker/tls-ca"
[ -f "$R/docker/tls/sp-ca.pem" ] || echo ca > "$R/docker/tls/sp-ca.pem"
[ -f "$R/docker/tls-ca/sp-ca.key" ] || echo key > "$R/docker/tls-ca/sp-ca.key"
while [ $# -gt 0 ]; do
  case "$1" in
    --model) cp "$2" "$R/tb/model.station.yaml" || exit 1; shift ;;
  esac
  shift
done
EOF
printf '#!/bin/bash\nexit 0\n' > "$S/scripts/install-web.sh"
printf '#!/bin/bash\nexit 0\n' > "$S/scripts/setup-ntp.sh"
sums() { (cd "$B" && find . -type f ! -name SHA256SUMS | sort | xargs sha256sum > SHA256SUMS); }
sums
sb() { (cd "$1" && shift && bash "$B/setup.sh" "$@" < /dev/null 2>&1); }

# 本站模型（在「现场目录」/site 下，相对路径给）
mkdir -p /site/sites-S19/S19-03 /site/bad
printf 'station:\n  id: S19-03\ncabinets:\n  - id: AH01\n' > /site/sites-S19/S19-03/model.yaml
: > /site/bad/empty.yaml
printf 'station:\n  id: x\n' > /site/bad/nocab.yaml

echo '== 拒绝（改系统之前）'
out="$(sb /site --role eg --model sites-S19/S19-03/model.yaml --yes)"; rc=$?
[ $rc != 0 ] && grep -q -- '--model 只用于子站主机' <<<"$out" && [ ! -e /opt/lsa-eg ] && ok "--role eg --model：拒（rc $rc），/opt/lsa-eg 没出现" || bad "--role eg --model：rc $rc：$(tail -2 <<<"$out")"
out="$(sb /site --role sp --model nosuch.yaml --ip 192.168.0.5 --yes)"; rc=$?
[ $rc != 0 ] && grep -q '没有这个文件 /site/nosuch.yaml' <<<"$out" && [ ! -e /opt/lsa9600sp ] && ok "文件不在：拒（rc $rc，报的是绝对路径 /site/nosuch.yaml），/opt/lsa9600sp 没出现" || bad "文件不在：rc $rc：$(tail -2 <<<"$out")"
out="$(sb /site --role sp --model bad/empty.yaml --ip 192.168.0.5 --yes)"; rc=$?
[ $rc != 0 ] && grep -q '是空文件' <<<"$out" && [ ! -e /opt/lsa9600sp ] && ok "空文件：拒（rc $rc），什么都没动" || bad "空文件：rc $rc：$(tail -2 <<<"$out")"
out="$(sb /site --role sp --model bad/nocab.yaml --ip 192.168.0.5 --yes)"; rc=$?
[ $rc != 0 ] && grep -q '没有 cabinets:' <<<"$out" && [ ! -e /opt/lsa9600sp ] && ok "没有 cabinets:：拒（rc $rc），什么都没动" || bad "没有 cabinets:：rc $rc：$(tail -2 <<<"$out")"
cp "$S/scripts/up.sh" /w/up.sh.new
printf '#!/bin/bash\n# 老 up.sh\nexit 0\n' > "$S/scripts/up.sh"; sums
out="$(sb /site --role sp --model sites-S19/S19-03/model.yaml --ip 192.168.0.5 --yes)"; rc=$?
[ $rc != 0 ] && grep -q '不认 --model' <<<"$out" && [ ! -e /opt/lsa9600sp ] && ok "包里的 up.sh 不认 --model：拒（rc $rc），什么都没动" || bad "老 up.sh：rc $rc：$(tail -2 <<<"$out")"
cp /w/up.sh.new "$S/scripts/up.sh"; sums

echo '== 透传'
rm -f /w/up-args
out="$(sb /site --role sp --model sites-S19/S19-03/model.yaml --ip 192.168.0.5 --yes)"; rc=$?
st=/opt/lsa9600sp/lsa9600sp-backend/tb/model.station.yaml
[ $rc = 0 ] && [ "$(cat /w/up-args 2>/dev/null)" = '--prod --model /site/sites-S19/S19-03/model.yaml' ] && cmp -s "$st" /site/sites-S19/S19-03/model.yaml \
  && ok "首次安装，setup.sh 直接跑、相对路径：up.sh 收到「$(cat /w/up-args)」，tb/model.station.yaml 一致" || bad "首次安装透传：rc $rc，up.sh 收到「$(cat /w/up-args 2>/dev/null)」：$(tail -3 <<<"$out")"

# .run：stub + 负载，从 /site 跑（stub 解到 /var/tmp/lsa9600sp-bundle.XXXX，setup.sh 再 cd 进去）
sed 's/\r$//' /deploy/bundle/stub.sh > /w/t.run
tar -c -C /w/b lsa9600sp-bundle >> /w/t.run
printf 'station:\n  id: S19-03\ncabinets:\n  - id: AH01\n  - id: AH02\n' > /site/m2.yaml
rm -f /w/up-args
out="$(cd /site && bash /w/t.run --role sp --model=./m2.yaml --yes < /dev/null 2>&1)"; rc=$?
[ $rc = 0 ] && [ "$(cat /w/up-args 2>/dev/null)" = '--prod --model /site/./m2.yaml' ] && cmp -s "$st" /site/m2.yaml \
  && ok "经 .run 升级、--model=./m2.yaml：up.sh 收到「$(cat /w/up-args)」，tb/model.station.yaml 换成新的" || bad ".run 透传：rc $rc，up.sh 收到「$(cat /w/up-args 2>/dev/null)」：$(tail -3 <<<"$out")"

rm -f /w/up-args
out="$(sb /site --role sp --yes)"; rc=$?
[ $rc = 0 ] && [ "$(cat /w/up-args 2>/dev/null)" = '--prod' ] && ok '不给 --model：up.sh 只收到「--prod」' || bad "不给 --model：rc $rc，up.sh 收到「$(cat /w/up-args 2>/dev/null)」"

echo; echo "== 结果：✓ $n_ok，✗ $fail"
[ "$fail" = 0 ]
IN
