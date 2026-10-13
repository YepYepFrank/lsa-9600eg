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
    ts = sorted({i[0] for i in items if key in i[3] and lo <= i[0] <= hi})
    gaps = [(a, b) for a, b in zip(ts, ts[1:]) if b - a > 1.5 * period]
    return ts, gaps


ok_all = True
for key, period, name in (('uv.int', 2000, '弧光（快 2 s）'), ('smoke.ppm', 10000, '气体（慢 10 s）')):
    ts, gaps = stream(key, period)
    print(f'\n== {name}：{f(lo)}–{f(hi)} 共 {len(ts)} 个采样时刻')
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
log = open(os.path.join(D, 'out', 'conv.log'), encoding='utf-8', errors='replace').read()
print('\n== 程序日志')
for l in log.splitlines():
    if re.search(r'MQTT 连接成功|MQTT 连接断开|MQTT 断线|发布失败|连接失败|补传完成|发现 \d+ 条缓存|超过快变量周期|Traceback|Error', l):
        print('  ', l[:200])
print('\n「轮询耗时超过快变量周期」次数：', len(re.findall('超过快变量周期', log)))
