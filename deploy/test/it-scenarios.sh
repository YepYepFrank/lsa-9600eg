#!/bin/bash
# 全链路联调的场景（it-lib.sh 建好、子站与 EG 都装好、conv 跑着之后）：逐段做、记时间线到 $LOG。约 40 分钟。
#   bash deploy/test/it-scenarios.sh <日志文件> [段号…]     不给段号 = 1–5 全做（例：… log.txt 4 只重做第 4 段）
# 1 通信三态：温湿度改挂 SAM-AH07-B → B 全量都有（ONLINE），sim 90–130 s 局放停（DEGRADED），140–220 s 温湿度停（DEGRADED）；A 没有任何数据（OFFLINE）
# 2 uv.pulse 去重：温湿度改回 A、重启 conv（sim 从头），70 s 那次弧光事件前后让总线卡 15 s，看本地 TB / 子站的 uv.pulse 条数与 agent 的去重日志
# 3 转换程序保险 · 总线重启：docker restart lsa-eg-mosquitto → agent 应重启 conv（原因 mosquitto-restart）
# 4 转换程序保险 · 60 s 没有读数：4a 杀掉 conv 里的 sim（传感器全断）→ 转换程序照发 q=invalid，设备 OFFLINE、不重启；
#   4b 冻住转换程序进程（卡死）→ agent 应在约 60 s 后重启 conv（原因 silent），读数回来
# 5 补传：EG → 子站拦 10 分钟（iptables），恢复后补传；子站侧数据有无空洞
# 全程每 10 s 记一次 conv 的内存
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/it-lib.sh"
LOG="${1:?日志文件}"
shift
PHASES="${*:-1 2 3 4 5}"
[ "$PHASES" = "1 2 3 4 5" ] && : > "$LOG"
ev() { echo "$(date +%s%3N) $(date '+%H:%M:%S') $*" | tee -a "$LOG"; }
comm() { egi docker exec -i -e MODE=comm lsa-eg-agent node - < "$HERE/it-probe.cjs" 2>/dev/null | grep -v '^Warning' >> "$LOG"; }
mem() { eg docker stats --no-stream --format '{{.MemUsage}}' lsa-eg-conv 2>/dev/null | sed "s/^/$(date '+%H:%M:%S') conv-mem /" >> "$LOG"; }
conv_dev() {  # 温湿度挂到哪个设备
  eg sed -i "s/^\(  device: \)\"SAM-AH07-[AB]\"/\1\"$1\"/" /opt/lsa-eg/config/conv/sensors/temperature.yaml
}
sample() {  # $1 秒数：每 10 s 采一次通信与内存
  local n=$(( $1 / 10 )) i
  for i in $(seq 1 "$n"); do sleep 10; comm; mem; done
}

p1() {
ev "== 1 通信三态（温湿度挂 B）"
conv_dev SAM-AH07-B
eg docker restart lsa-eg-conv >/dev/null; ev "conv 重启（sim 从 0 s 起）"
sample 250
ev "1 结束"
}

p2() {
ev "== 2 uv.pulse 去重（温湿度挂回 A）"
conv_dev SAM-AH07-A
eg docker restart lsa-eg-conv >/dev/null; ev "conv 重启（sim 从 0 s 起；70 s 有一次弧光事件）"
sleep 64; ev "总线卡住（docker pause lsa-eg-mosquitto）"; eg docker pause lsa-eg-mosquitto >/dev/null
sleep 15; eg docker unpause lsa-eg-mosquitto >/dev/null; ev "总线恢复"
sample 60
eg docker logs --since 3m lsa-eg-agent 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E 'uv.pulse|已处理过' | sed 's/^/    agent: /' >> "$LOG"
ev "2 结束"
}

p3() {
ev "== 3 转换程序保险：总线重启"
eg docker restart lsa-eg-mosquitto >/dev/null; ev "mosquitto 已重启"
sample 60
eg docker logs --since 2m lsa-eg-agent 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E '转换程序保险|自动重启' | sed 's/^/    agent: /' >> "$LOG"
ev "3 结束"
}

p4() {
ev "== 4a 传感器全断（杀掉 sim）：转换程序还活着，照发 q=invalid —— 设备应 OFFLINE + 设备失联告警，转换程序保险【不该】重启"
# conv 镜像（python:3.12-slim）没有 pgrep / pkill：按 /proc 找 sim.py
# （跳过 $$：这条 sh 自己的命令行里也有 sim.py）
simpids() { eg docker exec lsa-eg-conv sh -c 'for p in /proc/[0-9]*; do n=${p#/proc/}; [ "$n" = $$ ] && continue; grep -q sim.py $p/cmdline 2>/dev/null && echo $n; done'; }
eg docker exec lsa-eg-conv sh -c "kill $(echo $(simpids))"  # kill 只是 shell 内建，镜像里没有 /bin/kill
sleep 1
if [ -n "$(simpids)" ]; then ev "!! sim 没停掉"; else ev "conv 里的 sim 已停（串口没人应答）"; fi
sample 90
ev "== 4b 转换程序卡死（宿主机上 SIGSTOP 它的进程，docker 仍显示 running）：约 60 s 后转换程序保险应重启它（原因 silent），读数回来"
pid="$(eg docker inspect -f '{{.State.Pid}}' lsa-eg-conv)"
eg sh -c "kill -STOP $pid"; ev "conv 进程 $pid 已冻住"
sample 150
eg docker logs --since 5m lsa-eg-agent 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E '转换程序保险|自动重启|读数恢复' | sed 's/^/    agent: /' >> "$LOG"
ev "4 结束"
}

p5() {
ev "== 5 补传：EG → 子站拦 10 分钟"
eg iptables -I OUTPUT -d 172.21.0.2 -j DROP; ev "拦住（iptables OUTPUT DROP → 172.21.0.2）"
for i in $(seq 1 20); do sleep 30; mem; done
eg iptables -D OUTPUT -d 172.21.0.2 -j DROP; ev "放开"
sample 90
eg docker logs --since 15m lsa-eg-agent 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E '子站连接断开|已连子站|补传完成' | sed 's/^/    agent: /' >> "$LOG"
ev "5 结束"
}

for n in $PHASES; do "p$n"; done
ev "== 全部结束"
