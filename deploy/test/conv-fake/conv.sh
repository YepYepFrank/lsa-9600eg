#!/bin/sh
# 假转换程序：串口来一行「SAM-AH11-A env.t 25.1」就发一条 lsa/SAM-AH11-A/telemetry {"ts":收到时刻,"values":{"env.t":25.1}}
H=127.0.0.1
P=1884
echo "假转换程序：读 /dev/ttyS1，发到 $H:$P"
stty -F /dev/ttyS1 raw -echo 9600 2>/dev/null || true
while IFS=' ' read -r dev key val; do
  [ -n "$val" ] || continue
  ts="$(date +%s)000"
  mosquitto_pub -h "$H" -p "$P" -q 1 -i "lsa-conv-fake" -t "lsa/$dev/telemetry" -m "{\"ts\":$ts,\"values\":{\"$key\":$val}}" && echo "发 $dev $key=$val"
done < /dev/ttyS1
echo "串口读到头了（写端关了），退出等重启"
