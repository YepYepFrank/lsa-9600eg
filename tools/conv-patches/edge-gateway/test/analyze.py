# 分析 run.sh 的结果：每种情况的重连、补传完整性（ts 序列无空洞）、ts 是原采样时刻、轮询周期
import json, re, sys, os, datetime
D = sys.argv[1]
ev = {}
for l in open(os.path.join(D, 'out', 'events.log'), encoding='utf-8'):
    t, name = l.split(None, 1)
    ev[name.strip()] = int(t)
rows = [json.loads(l) for l in open(os.path.join(D, 'out', 'rec.jsonl'), encoding='utf-8') if l.strip()]
items = []  # (ts, at, batch, keys)
for r in rows:
    if r.get('topic', '').endswith('/telemetry'):
        b = r['body']
        for it in (b if isinstance(b, list) else [b]):
            items.append((it['ts'], r['at'], isinstance(b, list), set(it['values']), r['topic']))
topics = sorted({i[4] for i in items})
print('设备主题：', topics, '；记录器连上次数', sum(1 for r in rows if r.get('event') == 'connect'))
f = lambda ms: datetime.datetime.fromtimestamp(ms / 1000).strftime('%H:%M:%S')
print('事件：', '  '.join(f'{k} {f(v)}' for k, v in ev.items()))

windows = {
    'a 暂停 60 s': (ev['a-pause'], ev['a-unpause']),
    'b 容器重启': (ev['b-restart'], ev['b-restarted']),
    'c 程序先于总线': (ev['c-stop-broker'], ev['c-broker-started']),
}
lo, hi = ev['start'] + 15000, ev['end'] - 5000


def stream(key, period):
    """空洞按「1.5 × max(标称周期, 实测中位间隔)」判 —— 传感器本身就采得比标称慢（如 1.1.0 弧光每轮约 3.8 s）不算补传丢数"""
    ts = sorted({i[0] for i in items if key in i[3] and lo <= i[0] <= hi})
    sp = sorted(b - a for a, b in zip(ts, ts[1:]))
    med = sp[len(sp) // 2] if sp else period
    gaps = [(a, b) for a, b in zip(ts, ts[1:]) if b - a > 1.5 * max(period, med)]
    return ts, gaps, med


ok_all = True
for key, period, name in (('uv.int', 2000, '弧光（快 2 s）'), ('smoke.ppm', 10000, '气体（慢 10 s）')):
    ts, gaps, med = stream(key, period)
    print(f'\n== {name}：{f(lo)}–{f(hi)} 共 {len(ts)} 个采样时刻，实测中位间隔 {med / 1000:.1f} s')
    for a, b in gaps:
        where = [w for w, (x, y) in windows.items() if x - 5000 <= a <= y + 15000]
        print(f'   空洞 {f(a)} → {f(b)}（{(b - a) / 1000:.1f} s）{"  在「" + where[0] + "」" if where else ""}')
    if not gaps:
        print('   没有空洞')
    for w, (x, y) in windows.items():
        inside = [i for i in items if key in i[3] and x <= i[0] <= y]
        back = [i for i in inside if i[2]]
        late = [i for i in inside if i[1] - i[0] > 3000]
        print(f'   {w}：断开期间采样 {len({i[0] for i in inside})} 个，其中经补传（数组批量）{len({i[0] for i in back})} 个；'
              f'到达比采样晚 > 3 s 的 {len({i[0] for i in late})} 个（ts 是原采样时刻、不是补传时刻）'
              + (f'；最晚到达 {f(max(i[1] for i in inside))}' if inside else ''))
dup = len(items) - len({(i[0], tuple(sorted(i[3]))) for i in items})
print(f'\n重复（同 ts 同一组量收到多次）：{dup} 条（TB 按 ts 覆盖，无害）')

# 按设备：每个设备名的遥测条数、属性条数（1.1.0 起按传感器 yaml 的 device: 发）
print('\n== 按设备')
from collections import Counter
tel = Counter(i[4] for i in items)
attrs = Counter(r['topic'] for r in rows if r.get('topic', '').endswith('/attributes'))
for t in sorted(set(tel) | {x.replace('/attributes', '/telemetry') for x in attrs}):
    dev = t.split('/')[1]
    keys = sorted({k for i in items if i[4] == t for k in i[3] if not k.startswith('dev.') and k != 'q'})
    print(f'   {dev}：遥测 {tel.get(t, 0)} 条，属性 {attrs.get(t.replace("/telemetry", "/attributes"), 0)} 次，量 {", ".join(keys)}')
# 同一设备 ts 有没有往回走（按到达顺序）
back = Counter()
last = {}
for r in rows:
    if not r.get('topic', '').endswith('/telemetry'):
        continue
    for it in (r['body'] if isinstance(r['body'], list) else [r['body']]):
        for k in it['values']:
            key = (r['topic'], k)
            if key in last and it['ts'] < last[key]:
                back[r['topic'].split('/')[1]] += 1
            last[key] = it['ts']
print('   同一设备同一个量 ts 往回走：', dict(back) or 0)
ck = os.path.join(D, 'out', 'lsa_check.md')
if os.path.exists(ck):
    rep = open(ck, encoding='utf-8').read()
    def n(pat):
        return sum(int(m) for m in re.findall(r'\|[^|\n]*' + pat + r'[^|\n]*\| (\d+) \|', rep))
    print('\n== lsa_check 1.1（全程）')
    print('   「dev.fails 回 0 又跳回 / dev.* 互相覆盖」：', n('回 0 又跳回'))
    print('   「ts 往回走」：', n('往回走'))
    m = re.search(r'结论：\*\*(.+?)\*\*（错误 (\d+) 次、注意 (\d+) 次）', rep)
    if m:
        print(f'   结论 {m.group(1)}（错误 {m.group(2)}、注意 {m.group(3)}）')
    for l in rep.splitlines():
        if l.startswith('| 错误') or l.startswith('| 注意'):
            print('   ', l[:180])
log = open(os.path.join(D, 'out', 'conv.log'), encoding='utf-8', errors='replace').read()
print('\n== 程序日志')
for l in log.splitlines():
    if re.search(r'MQTT 连接成功|MQTT 连接断开|MQTT 断线|发布失败|连接失败|补传完成|发现 \d+ 条缓存|超过(快变量|最小组)周期|Traceback|Error|停止|已转入缓存', l):
        print('  ', l[:200])
print('\n「轮询耗时超过快变量周期 / 最小组周期」次数：', len(re.findall('超过(快变量|最小组)周期', log)))
