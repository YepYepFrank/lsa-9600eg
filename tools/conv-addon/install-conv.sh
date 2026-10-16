#!/bin/bash
# LSA-9600EG 转换程序接入包：在已装好 EG（0.6.1 / release-0.17.1）的机器上启用同事的转换程序（lsa-eg-conv）。
# 不联网，只用包里的东西。要 root：sudo bash install-conv.sh …
#
#   sudo bash install-conv.sh                    启用：导入镜像 → 生成 config/conv（已有就不动）→ 选串口 → 起 conv
#   sudo bash install-conv.sh --serial <设备>     指定串口。不给时：/dev/serial/by-id/ 下只有一个（USB 转 485）就用它；
#                                                有多个就列出来让选；一个都没有就用 /dev/ttyS1（X26A 的 COM2）
#   --sensors pd,gas,temperature,arc            打开哪几路，其余关（可用：pd gas temperature arc infrared；缺省前四个，红外关）
#   --addr pd=2,gas=3,temperature=4,arc=5       从站地址（缺省用同事的：红外 1、局放 2、气体 3、温湿度 4、弧光 5）
#   --dev temperature=SAM-AH07-A,pd=SAM-AH07-B  这一路挂到哪台设备（缺省：温湿度挂第一台 SAM，其余挂第二台；只有一台 SAM 就都挂它）
#   --baud 9600                                 波特率
#   --regen                                     按模板重新生成 config/conv（旧的备份成 config/conv.bak-<时间>）
#   --src <目录>                                现场改了同事的源码：把这个目录（同事仓库里的 src/）挂进容器顶替镜像里的，不用重打镜像
#   --status                                    看状态（容器、串口、各路配置、设备名核对、最近采集日志）
#   --diag [rs485|modbus]                       先停 conv，用同事的 rs485_test.py / pymodbus_diag.py 直接问从站，问完再起 conv
#   --sim                                       没有传感器时自测：在转换程序容器里跑 conv-kit/sim.py 模拟 5 台传感器（只这一次；
#                                                再不带 --sim 跑一次就回到真串口）
#   --check [秒]                                跑 conv-kit/lsa_check.py 检查总线上的消息格式（缺省 120 s；本机没有 python3 就在镜像里跑）
#   --off                                       停用（重跑 EG 的 install.sh 也保持停用）
#   --dir <EG 安装目录>                          缺省 /opt/lsa-eg
#
# 给了 --sensors / --addr / --dev / --baud 只改对应的项，现场手改过的其它配置不动；改完自动重启 conv。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR=/opt/lsa-eg MODE=on SERIAL='' SENSORS='' ADDR='' DEVS='' BAUD='' REGEN='' SRC='' DIAG='' SIM='' CHECK=120
while [ $# -gt 0 ]; do
  case "$1" in
    --serial) SERIAL="${2:?--serial 后面给串口设备}"; shift ;;
    --sensors) SENSORS="${2:?--sensors pd,gas,temperature,arc}"; shift ;;
    --addr) ADDR="${2:?--addr pd=2,gas=3}"; shift ;;
    --dev) DEVS="${2:?--dev temperature=SAM-AH07-A}"; shift ;;
    --baud) BAUD="${2:?--baud 9600}"; shift ;;
    --regen) REGEN=1 ;;
    --src) if [ "${2:-}" = none ]; then SRC=none; else SRC="$(cd "${2:?--src 后面给源码目录（none = 不挂了）}" && pwd)"; fi; shift ;;
    --sim) SIM=1 ;;
    --status) MODE=status ;;
    --check) MODE=check; [[ "${2:-}" =~ ^[0-9]+$ ]] && { CHECK="$2"; shift; } ;;
    --off) MODE=off ;;
    --diag) MODE=diag; case "${2:-}" in rs485 | modbus) DIAG="$2"; shift ;; *) DIAG=rs485 ;; esac ;;
    --dir) DIR="${2:?}"; shift ;;
    -h | --help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "不认识的参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
  shift
done
[ "$(id -u)" = 0 ] || { echo '要 root：sudo bash install-conv.sh …' >&2; exit 1; }
[ -f "$DIR/compose.yaml" ] && [ -f "$DIR/config/eg.yaml" ] || { echo "$DIR 下没有装好的 EG（compose.yaml、config/eg.yaml）：先装 EG，或用 --dir 指安装目录" >&2; exit 1; }
grep -q '^  conv:' "$DIR/compose.yaml" || { echo "$DIR/compose.yaml 里没有 conv 服务：EG 版本太老（要 0.4 以上，建议 0.6.1）" >&2; exit 1; }
IMG="$(grep -v '^#' "$HERE/CONV_IMAGE.txt" 2>/dev/null | head -1 | tr -d '[:space:]' || true)"
[ -n "$IMG" ] || { echo "$HERE/CONV_IMAGE.txt 里没有转换程序镜像名（包不完整？）" >&2; exit 1; }
cd "$DIR"
DC='docker compose'

env_get() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true; }
env_set() {  # 同 EG install.sh：有就改，没有就加
  if grep -qE "^$1=" .env 2>/dev/null; then sed -i "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi
}
sams() { awk '/^devices:/{f=1;next} f&&/^[^ ]/{f=0} f&&/^  - name:/{gsub(/"/,"",$3);print $3}' config/eg.yaml | grep '^SAM-' || true; }
alldevs() { awk '/^devices:/{f=1;next} f&&/^[^ ]/{f=0} f&&/^  - name:/{gsub(/"/,"",$3);print $3}' config/eg.yaml; }
file_of() {
  case "$1" in
    pd) echo pd.yaml ;; gas) echo gas.yaml ;; temperature) echo temperature.yaml ;; arc) echo arc_light.yaml ;; infrared) echo infrared.yaml ;;
    *) echo "不认识的传感器「$1」（可用：pd gas temperature arc infrared）" >&2; return 1 ;;
  esac
}
NAMES='pd gas temperature arc infrared'
declare -A CN=([pd]=局放 [gas]=气体 [temperature]=温湿度 [arc]=弧光 [infrared]=红外)
yget() { awk -v k="$2" '$1==k":"{v=$2;gsub(/"/,"",v);print v;exit}' "$1"; }  # 传感器 yaml 顶层字段（第一处）
yset() {  # $1 文件 $2 字段 $3 值（带引号的照样带引号）：只改第一处，行尾注释保留
  local q=''
  grep -qE "^  $2: *\"" "$1" && q='"'
  sed -i -E "0,/^  $2:/s#^(  $2: *)\"?[^\" ]*\"?#\1$q$3$q#" "$1"
}

# ---------- 串口 ----------
serial_list() {
  local t ty l d found
  for t in /sys/class/tty/ttyS*; do
    [ -e "$t/device" ] || continue
    ty="$(cat "$t/type" 2>/dev/null || echo 0)"
    [ "$ty" != 0 ] && echo "  /dev/$(basename "$t")（主板串口，UART 类型 $ty；X26A 的 COM2 是 /dev/ttyS1）"
  done
  for l in /dev/serial/by-id/*; do [ -e "$l" ] && echo "  $l → $(readlink -f "$l")（USB 转 485）"; done
  for d in /dev/ttyUSB* /dev/ttyACM*; do
    [ -e "$d" ] || continue
    found=''
    for l in /dev/serial/by-id/*; do [ "$(readlink -f "$l" 2>/dev/null || true)" = "$d" ] && found=1; done
    [ -n "$found" ] || echo "  $d（没有 by-id 名字：芯片没有序列号，拔插、重启后设备号可能变）"
  done
  true
}
serial_byid() {  # ttyUSB / ttyACM 换成 /dev/serial/by-id 的稳定名字（同 EG install.sh）
  local l real
  real="$(readlink -f "$1" 2>/dev/null || echo "$1")"
  case "$real" in /dev/ttyUSB* | /dev/ttyACM*) ;; *) echo "$1"; return 0 ;; esac
  for l in /dev/serial/by-id/*; do
    [ -e "$l" ] || continue
    case "$l" in *:* | *'#'* | *' '*) continue ;; esac
    if [ "$(readlink -f "$l")" = "$real" ]; then echo "$l"; return 0; fi
  done
  echo "$1"
}
pick_serial() {
  local ids=() l i n
  if [ -z "$SERIAL" ]; then
    for l in /dev/serial/by-id/*; do
      [ -e "$l" ] || continue
      case "$l" in *:* | *'#'* | *' '*) continue ;; esac
      ids+=("$l")
    done
    if [ ${#ids[@]} -eq 1 ]; then
      SERIAL="${ids[0]}"; echo "串口：只插了一个 USB 转 485，用它 —— $SERIAL → $(readlink -f "$SERIAL")"
    elif [ ${#ids[@]} -gt 1 ]; then
      echo "插了 ${#ids[@]} 个 USB 串口设备："
      for i in "${!ids[@]}"; do echo "  $((i + 1))) ${ids[$i]} → $(readlink -f "${ids[$i]}")"; done
      if [ -t 0 ]; then
        read -r -p "用哪个（输编号）：" n || n=''
        [[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -ge 1 ] && [ "$n" -le ${#ids[@]} ] || { echo '编号不对' >&2; exit 1; }
        SERIAL="${ids[$((n - 1))]}"
      else
        echo '用 --serial <上面的路径> 指定' >&2; exit 1
      fi
    else
      SERIAL="$(env_get EG_CONV_SERIAL)"; [ "$SERIAL" = /dev/null ] && SERIAL=''; SERIAL="${SERIAL:-/dev/ttyS1}"
      echo "串口：没插 USB 转 485，用 $SERIAL$([ "$SERIAL" = /dev/ttyS1 ] && echo '（X26A 的 COM2，BIOS 里要设成 RS-485）')"
    fi
  fi
  SERIAL="$(serial_byid "$SERIAL")"
  case "$SERIAL" in *:* | *'#'* | *' '*) echo "串口路径里有「:」「#」或空格，Docker 映射不了：$SERIAL —— 换成 /dev/ttyUSBn 再试" >&2; exit 1 ;; esac
  if [ ! -e "$SERIAL" ]; then
    echo "!! 串口 $SERIAL 不存在。本机能用的：" >&2; serial_list >&2; exit 1
  fi
}

# ---------- 配置 ----------
gen_config() {
  local code a b n f
  if [ -n "$REGEN" ] && [ -d config/conv ] && [ -n "$(ls -A config/conv 2>/dev/null)" ]; then
    mv config/conv "config/conv.bak-$(date +%Y%m%d-%H%M%S)"; echo "旧配置备份到 $(ls -d config/conv.bak-* | tail -1)"
  fi
  mkdir -p config/conv config/conv-data
  [ -f config/conv/gateway.yaml ] && return 1
  docker run --rm --network none --entrypoint tar "$IMG" -C /app/config.default -cf - . | tar -x -C config/conv
  code="$(awk '/^cabinet:/{f=1;next} f&&/^[^ ]/{f=0} f&&$1=="code:"{gsub(/["'\'']/,"",$2);print $2;exit}' config/eg.yaml)"
  mapfile -t S < <(sams)
  [ ${#S[@]} -gt 0 ] || { echo "!! eg.yaml 里没有 SAM 设备，转换程序的数据没有地方挂" >&2; exit 1; }
  a="${S[0]}"; b="${S[1]:-${S[0]}}"
  sed -i '/^serial:/,/^[a-z]/s#^\(  port: *\)"[^"]*"#\1"/dev/ttyS1"#' config/conv/gateway.yaml
  sed -i -E "/^device:/,/^[a-z]/s#^(  name: *)\"[^\"]*\"#\1\"$b\"#" config/conv/gateway.yaml
  for n in $NAMES; do
    f="config/conv/sensors/$(file_of "$n")"
    [ -f "$f" ] || continue
    if [ "$n" = temperature ]; then yset "$f" device "$a"; else yset "$f" device "$b"; fi
    case "$n" in infrared) yset "$f" enabled false ;; *) yset "$f" enabled true ;; esac
  done
  echo "转换程序配置：从镜像模板生成 config/conv/（柜号 ${code:-?}；温湿度 → $a，其余 → $b；局放、气体、温湿度、弧光打开，红外关；从站地址用同事的缺省）"
  return 0
}
apply_params() {  # 只改给了的项；有改动返回 0
  local changed=1 kv k v f n
  if [ -n "$SENSORS" ]; then
    for n in ${SENSORS//,/ }; do file_of "$n" >/dev/null || exit 2; done
    for n in $NAMES; do
      f="config/conv/sensors/$(file_of "$n")"; [ -f "$f" ] || continue
      case ",$SENSORS," in *",$n,"*) v=true ;; *) v=false ;; esac
      [ "$(yget "$f" enabled)" = "$v" ] || { yset "$f" enabled "$v"; changed=0; }
    done
  fi
  for kv in ${ADDR//,/ }; do
    k="${kv%%=*}"; v="${kv#*=}"; f="config/conv/sensors/$(file_of "$k")" || exit 2
    [[ "$v" =~ ^[0-9]+$ ]] && [ "$v" -ge 1 ] && [ "$v" -le 247 ] || { echo "从站地址要 1–247：$kv" >&2; exit 2; }
    [ "$(yget "$f" slave_id)" = "$v" ] || { yset "$f" slave_id "$v"; changed=0; }
  done
  for kv in ${DEVS//,/ }; do
    k="${kv%%=*}"; v="${kv#*=}"; f="config/conv/sensors/$(file_of "$k")" || exit 2
    alldevs | grep -qx "$v" || { echo "!! eg.yaml 里没有设备「$v」。有的：$(alldevs | tr '\n' ' ')" >&2; exit 2; }
    [ "$(yget "$f" device)" = "$v" ] || { yset "$f" device "$v"; changed=0; }
  done
  if [ -n "$BAUD" ]; then
    grep -qE "^  baudrate: *$BAUD\b" config/conv/gateway.yaml || { sed -i -E "/^serial:/,/^[a-z]/s#^(  baudrate: *)[0-9]+#\1$BAUD#" config/conv/gateway.yaml; changed=0; }
  fi
  return $changed
}
check_devices() {  # 打开的各路 device 都要在 eg.yaml 里
  local f dev bad=() names
  names=" $(alldevs | tr '\n' ' ') "
  for f in config/conv/sensors/*.yaml; do
    [ "$(yget "$f" enabled)" = true ] || continue
    dev="$(yget "$f" device)"
    case "$names" in *" $dev "*) ;; *) bad+=("$(basename "$f") 的 device「${dev:-空}」") ;; esac
  done
  if [ ${#bad[@]} -gt 0 ]; then
    echo "!! 转换程序配置的设备名和 eg.yaml 对不上（这些数据进不了本地 TB、也不上送）：${bad[*]}" >&2
    echo "   eg.yaml 里的设备：$names" >&2
  fi
  true
}
show_config() {
  local f n
  echo "各路传感器（config/conv/sensors/，串口 $(env_get EG_CONV_SERIAL) → 容器里 /dev/ttyS1，波特率 $(awk '/^serial:/{f=1} f&&$1=="baudrate:"{print $2;exit}' config/conv/gateway.yaml)）："
  for n in $NAMES; do
    f="config/conv/sensors/$(file_of "$n")"; [ -f "$f" ] || continue
    printf '  %-4s %-11s %-4s 从站 %-3s 挂在 %s\n' "${CN[$n]}" "$(basename "$f")" "$([ "$(yget "$f" enabled)" = true ] && echo 打开 || echo 关)" "$(yget "$f" slave_id)" "$(yget "$f" device)"
  done
  check_devices
}

# ---------- compose ----------
write_override() {
  local o=compose.override.yaml src=''
  if [ -f "$o" ] && ! grep -q 'conv-addon' "$o"; then
    cp "$o" "$o.bak-$(date +%Y%m%d-%H%M%S)"; echo "!! 原有的 $o 已备份成 $o.bak-*，下面换成转换程序接入包的（原来的内容要的话手工合进来）" >&2
  fi
  # --src 没给：沿用上次挂的源码目录；--src none：不挂了，回到镜像里的
  [ -f "$o" ] && src="$(sed -n 's#^ *- \(.*\):/app/src:ro$#\1#p' "$o" | head -1)"
  [ -n "$SRC" ] && src="$SRC"
  [ "$src" = none ] && src=''
  {
    echo '# 转换程序接入包（conv-addon）写的，docker compose 自动合并；重跑 install-conv.sh 会重写'
    echo 'services:'
    echo '  conv:'
    echo '    environment:'
    echo '      EDGE_GATEWAY_CONFIG: /config'
    echo '      LSA_HEARTBEAT: /data/heartbeat'
    # --sim：模拟器在容器里造虚拟串口（pty 只在造它的容器里能用，不能从宿主机映射进去）
    [ -n "$SIM" ] && echo '      LSA_SERIAL: /tmp/ttyV0'
    if [ -n "$src" ] || [ -n "$SIM" ]; then
      echo '    volumes:'
      [ -n "$src" ] && echo "      - $src:/app/src:ro"
      [ -n "$SIM" ] && echo "      - $HERE/conv-kit:/kit:ro"
    fi
    [ -n "$SIM" ] && echo "    entrypoint: ['sh', '-c', 'python3 /kit/sim.py /tmp/ttyV0 > /data/sim.log 2>&1 & sleep 1; exec sh /entrypoint.sh']"
    true
  } > "$o.new"
  mv "$o.new" "$o"
  [ -n "$src" ] && echo "源码：挂 $src 顶替镜像里的 /app/src（--src none 取消）"
  [ -n "$SIM" ] && echo "自测：用模拟器（conv-kit/sim.py）代替真传感器。测完不带 --sim 再跑一次回到真串口"
  true
}
conv_logs() { docker logs --since "${1:-2m}" lsa-eg-conv 2>&1 | grep -E '采集成功|采集失败|ERROR|已连接|连接失败|Modbus' | tail -"${2:-8}" | cut -c1-200 || true; }

verdict() {  # 最近 30 s 的采集，一句话结论
  local l ok bad open
  l="$(docker logs --since 30s lsa-eg-conv 2>&1 || true)"
  ok="$(grep -c '采集成功' <<<"$l" || true)"; bad="$(grep -c '采集失败' <<<"$l" || true)"; open="$(grep -c '连接失败' <<<"$l" || true)"
  if [ "$open" -gt 0 ] && [ "$ok" = 0 ]; then echo "→ 串口打不开（$SERIAL）：USB 模块是否插好；用 COM2 时 BIOS 是否设成 RS-485。可选串口见 --status"
  elif [ "$ok" -gt 0 ] && [ "$bad" = 0 ]; then echo "→ 通了：30 s 内采集成功 $ok 次。去本地页看数据，再跑 lsa_check"
  elif [ "$ok" -gt 0 ]; then echo "→ 部分通：成功 $ok 次、失败 $bad 次。失败的那几路查从站地址 / 接线，不接的用 --sensors 关掉"
  elif [ "$bad" -gt 0 ]; then echo "→ 串口开了但传感器都没应答（失败 $bad 次）：查 A/B 接线、从站地址、波特率、供电；--diag 直接问从站"
  else echo "→ 还没有采集结果，过一会儿 --status 再看"; fi
}
status() {
  echo "== 转换程序（$DIR）"
  if grep -q '^EG_CONV=off' .env 2>/dev/null; then echo '状态：已停用（--off）。启用：sudo bash install-conv.sh'; fi
  docker ps -a --filter name=^lsa-eg-conv$ --format '容器：{{.Status}}，镜像 {{.Image}}' | grep . || echo '容器：没有'
  [ -f config/conv/gateway.yaml ] && show_config
  [ -n "$(grep ':/app/src:ro' compose.override.yaml 2>/dev/null)" ] && echo "源码：用的是挂进来的 $(grep ':/app/src:ro' compose.override.yaml | sed 's/ *- //;s/:\/app\/src:ro//')（--src）"
  if docker ps --filter name=^lsa-eg-conv$ -q | grep -q .; then
    echo '最近 2 分钟的采集：'; conv_logs 2m 10 | sed 's/^/  /'
    SERIAL="$(env_get EG_CONV_SERIAL)"; verdict
  fi
  echo "本地页：浏览器开 http://<EG 地址>/ → 设备与通信 → 服务状态（转换程序卡片）/ 实时数据"
  echo "检查消息格式：sudo bash $0 --check"
  echo "可选串口："; serial_list
}

case "$MODE" in
  status) status; exit 0 ;;
  check)
    echo "== lsa_check 检查 $CHECK s（按 $DIR/config/eg.yaml 的设备清单）"
    if command -v python3 >/dev/null; then
      python3 "$HERE/conv-kit/lsa_check.py" --eg-yaml config/eg.yaml --duration "$CHECK"
    else
      docker run --rm --network host -v "$HERE/conv-kit:/kit:ro" -v "$DIR/config/eg.yaml:/eg.yaml:ro" --entrypoint python3 "$IMG" /kit/lsa_check.py --eg-yaml /eg.yaml --duration "$CHECK"
    fi
    exit 0 ;;
  off)
    env_set EG_CONV off; env_set COMPOSE_PROFILES ''
    docker rm -f lsa-eg-conv >/dev/null 2>&1 || true
    echo '转换程序已停用（重跑 EG 的 install.sh 也保持停用）。再启用：sudo bash install-conv.sh'; exit 0 ;;
esac

# ---------- 导入镜像 ----------
# EG 0.6.2 起发布件带这个镜像，install.sh 已导入；单独的接入包（conv-addon）在这里导入
if ! docker image inspect "$IMG" >/dev/null 2>&1; then
  [ -f "$HERE/images-conv.tar.gz" ] || { echo "!! 本机没有镜像 $IMG，$HERE 下也没有 images-conv.tar.gz：用带转换程序镜像的 EG 发布件重跑 install.sh，或用接入包" >&2; exit 1; }
  echo "导入转换程序镜像 $IMG …"
  docker load -i "$HERE/images-conv.tar.gz" | tail -1
fi
docker image inspect "$IMG" >/dev/null 2>&1 || { echo "!! 镜像 $IMG 导入失败" >&2; exit 1; }

if [ "$MODE" = diag ]; then
  pick_serial
  gid="$(getent group dialout | cut -d: -f3)"
  echo "== 先停转换程序（它占着串口）"; docker stop lsa-eg-conv >/dev/null 2>&1 || true
  s="$([ "$DIAG" = modbus ] && echo pymodbus_diag.py || echo rs485_test.py)"
  echo "== 同事的 $s：串口 $SERIAL（容器里 /dev/ttyS0），9600 8N1"
  t=(); [ -t 0 ] && t=(-it)
  docker run --rm "${t[@]}" --network none --device "$SERIAL:/dev/ttyS0" --group-add "${gid:-20}" --entrypoint python3 "$IMG" "/app/tools/$s" || true
  if [ -f config/conv/gateway.yaml ] && ! grep -q '^EG_CONV=off' .env; then
    echo "== 诊断完，重新起转换程序"; docker start lsa-eg-conv >/dev/null 2>&1 || $DC --profile conv up -d conv
  fi
  exit 0
fi

# ---------- 启用 ----------
if [ -n "$SIM" ] && [ -z "$SERIAL" ]; then SERIAL=/dev/null; else pick_serial; fi
gen_config && fresh=1 || fresh=''
apply_params && changed=1 || changed=''
env_set EG_CONV on
env_set EG_CONV_IMAGE "$IMG"
env_set EG_CONV_SERIAL "$SERIAL"
show_config
env_set EG_DIALOUT_GID "$(getent group dialout | cut -d: -f3)"
env_set COMPOSE_PROFILES conv
# 重跑 EG 的 install.sh（同一个安装目录）时它认这个文件，转换程序保持启用
echo "$IMG" > CONV_IMAGE.txt
write_override
echo "== 起转换程序"
$DC --profile conv up -d conv 2>&1 | grep -vE '^\s*$' | tail -3
[ -n "$changed" ] && [ -z "$fresh" ] && { docker restart lsa-eg-conv >/dev/null; echo '配置改了，已重启转换程序'; }
echo "== 等 20 s 看采集"
sleep 20
docker ps --filter name=^lsa-eg-conv$ --format '容器：{{.Status}}'
conv_logs 30s 10 | sed 's/^/  /'
verdict
echo
echo "启用完成。看状态：sudo bash $0 --status；停用：--off；直接问从站：--diag"
echo "本地页：http://<EG 地址>/ → 设备与通信；检查消息格式：sudo bash $0 --check"
