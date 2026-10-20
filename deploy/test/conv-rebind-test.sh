#!/bin/bash
# install-conv.sh --rebind 回归（0.18.0 舱室 EG，P6 摸底查出：拆柜后原来那台改作单元 A，转换程序还按整柜的设备名、旧 clientId 跑）。
# 在一次性容器里跑，不起真的转换程序：docker 换成替身（记下调用；restart 后「日志」里的 clientId 换成 eg.yaml 的单元号），
# 传感器配置取转换程序镜像里的模板（本机已有的镜像，不下载）：
#   bash deploy/test/conv-rebind-test.sh [转换程序镜像，缺省 CONV_IMAGE 同发布件]
set -euo pipefail
export MSYS_NO_PATHCONV=1
IMG="${1:-lsa-eg-conv:1.1.1-p6}"
ROOT="$(cd "$(dirname "$0")/../.." && (pwd -W 2>/dev/null || pwd))"
docker image inspect "$IMG" >/dev/null 2>&1 || { echo "本机没有 $IMG" >&2; exit 1; }
TPL="$(mktemp -d)"
trap 'rm -rf "$TPL"' EXIT
docker run --rm --pull never --network none --entrypoint tar "$IMG" -C /app/config.default -cf - . > "$TPL/tpl.tar"
echo "转换程序模板取自 $IMG"
docker run --rm --pull never -i -v "$ROOT/tools:/tools:ro" -v "$(cd "$TPL" && (pwd -W 2>/dev/null || pwd)):/tpl:ro" --entrypoint bash ubuntu:24.04 -s <<'EOS'
set -uo pipefail
fail=0; n=0
ok() { n=$((n+1)); echo "  ✓ $*"; }
bad() { n=$((n+1)); echo "  ✗ $*"; fail=1; }
E=/opt/lsa-eg
mkdir -p $E/config/conv /usr/local/bin
tr -d '\r' < /tools/conv-addon/install-conv.sh > $E/install-conv.sh
printf '# 测试\nlsa-eg-conv:test\n' > $E/CONV_IMAGE.txt
printf 'services:\n  conv:\n    image: x\n' > $E/compose.yaml
# docker 替身：inspect / logs 按 /tmp/cid 回答；restart 时按 eg.yaml 当时的单元号换 clientId（同事程序启动时读 eg.yaml）
cat > /usr/local/bin/docker <<'EOF'
#!/bin/bash
echo "docker $*" >> /tmp/docker.log
case "$1" in
  inspect) [ "$2" = -f ] && echo 2026-10-19T00:00:00Z; exit 0 ;;
  logs) echo "2026-10-19 | INFO | mqtt_client | MQTT 连接成功: 127.0.0.1:1884 (client_id=$(cat /tmp/cid))"; exit 0 ;;
  restart)
    u="$(awk '/^unit:/{f=1;next} f&&/^[^ ]/{f=0} f&&$1=="code:"{print $2;exit}' /opt/lsa-eg/config/eg.yaml)"
    echo "lsa-conv-$u" > /tmp/cid; exit 0 ;;
  ps|image) exit 0 ;;
esac
exit 0
EOF
chmod +x /usr/local/bin/docker
eg_yaml() {  # $1 单元号 $2.. 设备
  local u="$1"; shift
  { echo 'schema: 2'; echo 'unit:'; echo "  id: ${u##*-}"; echo "  code: $u"; echo '  at: 断路器室'; echo '  index: 31'
    echo 'cabinet:'; echo '  code: AH07'; echo 'devices:'
    for d in "$@"; do
      case "$d" in SAM-*) k=sam ;; PM-* | PM2-*) k=meter ;; CAM-*) k=camera ;; *) k=x ;; esac
      echo "  - name: $d"; echo "    kind: $k"; echo '    attrs:'; echo '      port: COM2'
      [ "$k" = meter ] && echo "      proto: Modbus RTU · 从站 ${METER_SLAVE:-6} · 9600"
    done; } > $E/config/eg.yaml
}
fresh_conv() {  # 拆柜前整柜那份：温湿度 → SAM-AH07-A，其余 → SAM-AH07-B
  rm -rf $E/config/conv; mkdir -p $E/config/conv; tar -x -C $E/config/conv -f /tpl/tpl.tar
  sed -i -E '/^device:/,/^[a-z]/s#^(  name: *)"[^"]*"#\1"SAM-AH07-B"#' $E/config/conv/gateway.yaml
  for f in $E/config/conv/sensors/*.yaml; do sed -i -E '0,/^  device:/s#^(  device: *)"[^"]*"#\1"SAM-AH07-B"#' "$f"; done
  sed -i -E '0,/^  device:/s#^(  device: *)"[^"]*"#\1"SAM-AH07-A"#' $E/config/conv/sensors/temperature.yaml
  sed -i -E '0,/^  slave_id:/s#^(  slave_id: *)[0-9]+#\117#' $E/config/conv/sensors/pd.yaml   # 现场改过的从站地址，改挂不能动
}
devs() { grep -h '^  device:' $E/config/conv/sensors/*.yaml | sed -E 's/^  device: *"?([^" ]*)"?.*/\1/' | sort | uniq -c | tr -s ' ' | tr '\n' ';'; }
gw() { awk '/^device:/{f=1;next} f&&/^[^ ]/{f=0} f&&$1=="name:"{gsub(/"/,"",$2);print $2;exit}' $E/config/conv/gateway.yaml; }

echo "== 1. 原来那台改作 AH07-A（单元只有 SAM-AH07-A），转换程序启用中、clientId 还是 lsa-conv-AH07"
eg_yaml AH07-A SAM-AH07-A PM-AH07 CAM-AH07-A; fresh_conv; echo 'EG_CONV=on' > $E/.env; echo lsa-conv-AH07 > /tmp/cid; : > /tmp/docker.log
out="$(bash $E/install-conv.sh --status 2>&1)"
grep -q '还按旧单元跑（lsa-conv-AH07）' <<<"$out" && ok "--status 提示还按旧单元跑" || bad "--status 没提示旧单元：$(grep 单元 <<<"$out")"
out="$(bash $E/install-conv.sh --rebind 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "--rebind rc 0" || bad "--rebind rc $rc：$out"
[ "$(devs)" = " 5 SAM-AH07-A;" ] && ok "各路都挂到 SAM-AH07-A（$(devs)）" || bad "改挂后：$(devs)"
[ "$(gw)" = SAM-AH07-A ] && ok "gateway.yaml device.name → SAM-AH07-A" || bad "gateway.yaml device.name：$(gw)"
grep -qE '^  slave_id: *17' $E/config/conv/sensors/pd.yaml && ok "现场改过的从站地址（局放 17）没动" || bad "从站地址被改了"
grep -q '^docker restart lsa-eg-conv' /tmp/docker.log && ok "重启了转换程序" || bad "没重启转换程序：$(cat /tmp/docker.log)"
grep -q 'clientId lsa-conv-AH07-A' <<<"$out" && ok "说了新 clientId lsa-conv-AH07-A" || bad "没说新 clientId：$out"
out="$(bash $E/install-conv.sh --status 2>&1)"
grep -q '还按旧单元跑' <<<"$out" && bad "改挂后 --status 还提示旧单元" || ok "改挂后 --status 不再提示（连着用的 $(cat /tmp/cid)）"

echo "== 2. 再跑一次 --rebind：没什么可改，照样重启（clientId 对得上）"
: > /tmp/docker.log
out="$(bash $E/install-conv.sh --rebind 2>&1)"
grep -q '都在 eg.yaml 里，不用改' <<<"$out" && ok "说不用改" || bad "第二次：$out"

echo "== 3. 原来那台改作 AH07-B（单元只有 SAM-AH07-B）：只有温湿度要改挂"
eg_yaml AH07-B SAM-AH07-B CAM-AH07-B; fresh_conv; echo lsa-conv-AH07 > /tmp/cid
out="$(bash $E/install-conv.sh --rebind 2>&1)"
grep -q '温湿度（temperature.yaml）：SAM-AH07-A → SAM-AH07-B' <<<"$out" && ok "温湿度 SAM-AH07-A → SAM-AH07-B" || bad "$out"
[ "$(grep -c ' → ' <<<"$out")" = 1 ] && ok "只改了这一路" || bad "改了 $(grep -c ' → ' <<<"$out") 处"

echo "== 4. 转换程序没启用：只改配置，不重启"
eg_yaml AH07-A SAM-AH07-A; fresh_conv; echo 'EG_CONV=off' > $E/.env; : > /tmp/docker.log
out="$(bash $E/install-conv.sh --rebind 2>&1)"; rc=$?
[ "$rc" = 0 ] && [ "$(devs)" = " 5 SAM-AH07-A;" ] && ok "改挂了（$(devs)）" || bad "rc $rc $(devs)"
grep -q 'restart' /tmp/docker.log && bad "没启用也重启了" || ok "没重启"

echo "== 5. 还没生成过 config/conv：什么都不做"
rm -rf $E/config/conv; out="$(bash $E/install-conv.sh --rebind 2>&1)"; rc=$?
[ "$rc" = 0 ] && grep -q '不用改挂' <<<"$out" && ok "rc 0、说不用改挂" || bad "rc $rc：$out"

echo "== 6. 电表（补丁 0007 的 meter.yaml）跟着单元走"
add_meter() {  # 拆柜前整柜那份：电表挂 PM-AH07、打开
  printf 'sensor:\n  name: "meter"\n  device: "PM-AH07"\n  slave_id: 6\n  enabled: true\n' > $E/config/conv/sensors/meter.yaml
}
mget() { awk -v k="$1" '$1==k":"{v=$2;gsub(/"/,"",v);print v;exit}' $E/config/conv/sensors/meter.yaml; }
eg_yaml AH07-A SAM-AH07-A PM-AH07 CAM-AH07-A; fresh_conv; add_meter; echo 'EG_CONV=on' > $E/.env
out="$(bash $E/install-conv.sh --rebind 2>&1)"
[ "$(mget enabled)" = true ] && [ "$(mget device)" = PM-AH07 ] && ! grep -q '电表（meter.yaml）' <<<"$out" && ok "改作 A（电表归 A）：电表照旧打开、挂 PM-AH07，不提" || bad "A：enabled $(mget enabled) device $(mget device)；$out"
eg_yaml AH07-B SAM-AH07-B CAM-AH07-B; fresh_conv; add_meter
out="$(bash $E/install-conv.sh --rebind 2>&1)"
[ "$(mget enabled)" = false ] && grep -q '本单元没有电表' <<<"$out" && ok "改作 B（电表不归 B）：电表这一路关掉、说清楚" || bad "B：enabled $(mget enabled)；$out"
grep -q 'meter.yaml 的 device' <<<"$(bash $E/install-conv.sh --status 2>&1)" && bad "关掉以后 --status 还报电表设备名对不上" || ok "关掉以后不再报「设备名对不上」"
eg_yaml AH07-A SAM-AH07-A PM-AH09 CAM-AH07-A; fresh_conv; add_meter
out="$(bash $E/install-conv.sh --rebind 2>&1)"
[ "$(mget device)" = PM-AH09 ] && grep -q '电表（meter.yaml）：PM-AH07 → PM-AH09' <<<"$out" && ok "eg.yaml 的电表换了名：改挂 PM-AH09" || bad "改名：device $(mget device)；$out"

echo "== 7. 电表从站号：attrs.slave 优先，其次 proto 的「从站 N」，都没有 = 6"
awk '/^meter_slave\(\) \{/,/^\}/' $E/install-conv.sh > /tmp/ms.sh; cd $E; . /tmp/ms.sh
METER_SLAVE=9 eg_yaml AH07-A SAM-AH07-A PM-AH07; [ "$(meter_slave PM-AH07)" = 9 ] && ok "proto「从站 9」→ 9" || bad "proto：$(meter_slave PM-AH07)"
sed -i 's/^      port: COM2$/      port: COM2\n      slave: 12/' config/eg.yaml; [ "$(meter_slave PM-AH07)" = 12 ] && ok "attrs.slave 12 优先" || bad "attrs.slave：$(meter_slave PM-AH07)"
eg_yaml AH07-A SAM-AH07-A; [ "$(meter_slave PM-AH07)" = 6 ] && ok "没有 → 6" || bad "没有：$(meter_slave PM-AH07)"
cd /

echo
[ "$fail" = 0 ] && echo "== 通过（$n 项）" || { echo "== 有失败项"; exit 1; }
EOS
