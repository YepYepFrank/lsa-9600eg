#!/usr/bin/env bash
# EG 数据盘容量 / 写入量 / 寿命估算（G6，开发计划 v0.4）。在部署目录里跑：
#
#   sudo bash diskcheck.sh              现状 + 60 s 采样写入速率
#   sudo bash diskcheck.sh 600 600      采样 600 s；按 600 TBW 的盘算寿命（缺省 TBW 取 EG_SSD_TBW 或 300）
#
# 写入速率取块设备的累计写扇区（/proc/diskstats）两次相减，含本地 TB、循环录像、outbox、证据、日志全部写入；
# 有 smartctl 时另报盘自己记的累计写入（NVMe「Data Units Written」/ SATA 241 号属性）。
set -uo pipefail
cd "$(dirname "$0")"
SAMPLE="${1:-60}"
TBW="${2:-${EG_SSD_TBW:-300}}"

src="$(df --output=source . | tail -1)"
dev="$(lsblk -no PKNAME "$src" 2>/dev/null | head -1)"   # sete-ok：本脚本没有 set -e
[ -n "$dev" ] || dev="$(basename "$src")"
echo "部署目录 $(pwd) 在 $src（盘 $dev）"
df -h --output=size,used,avail,pcent . | sed 's/^/  /'

echo
echo '各部分占用：'
du_of() { [ -e "$2" ] && printf '  %-28s %s\n' "$1" "$(du -sh "$2" 2>/dev/null | cut -f1)"; }
du_of '循环录像 recordings/' recordings
du_of '证据 config/evidence/' config/evidence
du_of 'outbox config/outbox.db' config/outbox.db
du_of '事件库 config/events.db' config/events.db
for v in pg tb-data tb-logs gw-logs mq-data; do
  p="$(docker volume inspect -f '{{.Mountpoint}}' "lsa-eg_$v" 2>/dev/null)" && du_of "卷 $v" "$p"
done
du_of 'Docker 容器日志' /var/lib/docker/containers
du_of 'Docker 镜像层' /var/lib/docker/overlay2
du_of 'journald' /var/log/journal

sectors() { awk -v d="$dev" '$3==d{print $10}' /proc/diskstats; }
s0="$(sectors)"
if [ -z "$s0" ]; then echo "读不到 /proc/diskstats 里的 $dev"; exit 1; fi
up="$(cut -d. -f1 /proc/uptime)"
echo
echo "开机以来（$((up / 3600)) h）平均写入：$(awk -v s="$s0" -v t="$up" 'BEGIN{printf "%.1f GB/天", s*512/t*86400/1e9}')"
echo "采样 $SAMPLE s ..."
sleep "$SAMPLE"
s1="$(sectors)"
awk -v a="$s0" -v b="$s1" -v t="$SAMPLE" -v tbw="$TBW" 'BEGIN{
  bps=(b-a)*512/t; day=bps*86400/1e9
  printf "当前写入：%.2f MB/s ≈ %.1f GB/天 ≈ %.2f TB/年\n", bps/1e6, day, day*365/1000
  if (day>0) printf "按 %d TBW 的盘：约 %.1f 年写满额定寿命\n", tbw, tbw*1000/day/365
}'

if command -v smartctl >/dev/null; then
  echo
  smartctl -A "/dev/$dev" 2>/dev/null | grep -Ei 'Data Units Written|Total_LBAs_Written|Percentage Used|Wear_Leveling|Power_On_Hours' | sed 's/^/  /'
else
  echo '（没有 smartctl：盘自己记的累计写入与磨损看不了；装 smartmontools 可看）'
fi
