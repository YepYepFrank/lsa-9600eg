#!/usr/bin/env bash
# set -e 陷阱检查（取自子站后端库 scripts/sete-lint.sh 736109f，缺省路径改成本库的）：shell 脚本都是 set -euo pipefail，
# 下面几种写法会让脚本「悄悄退出」（没有任何报错就停了），EG install.sh 就因此全新安装失败过（0.13 验收）。
# pack:eg、bundle 打包前跑，有一条就不出包。
#   scripts/sete-lint.sh [文件…]      缺省查 deploy/eg、deploy/bundle、deploy/test 下的 *.sh
# 查的写法（启发式，逐行看；确认没问题的行在行尾写 # sete-ok 跳过）：
#   1. 命令替换里有 grep / head 却没有 || 兜底：grep 没匹配返回 1；| head 截断大输出时上游收到 SIGPIPE（141）
#      —— pipefail 下整句赋值失败。local x="$(…)" 不算（local 吞掉返回码）
#   2. 不在 while 条件里、也没有 || 兜底的 read：读到 EOF（没有终端、stdin 已关）返回 1
#   3. 函数的最后一句是 [ … ] && …：条件不成立时函数返回 1，调用处退出（顶层循环里的不算，bash 会豁免）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ $# -gt 0 ]; then files=("$@"); else files=("$ROOT"/deploy/eg/*.sh "$ROOT"/deploy/bundle/*.sh "$ROOT"/deploy/test/*.sh); fi

n=0
for f in "${files[@]}"; do
  out="$(awk -v F="${f#"$ROOT"/}" '
    { line[NR] = $0 }
    END {
      for (i = 1; i <= NR; i++) {
        s = line[i]
        if (s ~ /# sete-ok/ || s ~ /^[ \t]*#/) continue
        # 1. 赋值 = 命令替换，里面有 grep / head，没有 ||（多行的命令替换看到右括号为止）
        if (s ~ /^[ \t]*(export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*="?\$\(/) {
          body = s; j = i
          while (body !~ /\)"?[ \t]*(;.*|#.*)?$/ && j < NR && j < i + 6) { j++; body = body "\n" line[j] }
          if (body ~ /(^|[ |(])(grep|head)[ \t]/ && body !~ /\|\|/) printf "%s:%d: 命令替换里有 grep / head，没有 || true 兜底\n", F, i
        }
        # 2. read：不在 while 条件里、没有 ||
        if (s ~ /(^|[;&|{ \t])read[ \t]+-/ && s !~ /while[ \t]/ && s !~ /\|\|/ && s !~ /<<</ && s !~ /^[ \t]*done/) printf "%s:%d: read 没有 || 兜底（读到 EOF 返回 1）\n", F, i
        # 3. 函数末尾的 [ … ] && …（下一行是单独的右花括号）
        if (s ~ /^[ \t]*\[\[? .*\]\]? && / && i < NR && line[i + 1] ~ /^[ \t]*}[ \t]*$/) printf "%s:%d: 函数最后一句是 [ … ] && …（条件不成立时函数返回 1）\n", F, i
      }
    }' "$f")"
  if [ -n "$out" ]; then
    printf '%s\n' "$out"
    n=$((n + $(printf '%s\n' "$out" | wc -l)))
  fi
done
if [ "$n" -gt 0 ]; then
  echo "set -e 陷阱：$n 处（见上；确认没问题的在行尾写 # sete-ok）" >&2
  exit 1
fi
echo "set -e 陷阱：${#files[@]} 个脚本没发现"
