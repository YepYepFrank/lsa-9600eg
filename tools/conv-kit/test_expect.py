#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""lsa_check 按转换程序配置算预期测点（W1，用户 2026-10-20 选 ①）的自检。只用标准库：
  python3 test_expect.py [同事配置的 sensors 目录，可选：再拿真配置核一遍解析]
三种情况：分挂两台（A 只温湿度、B 局放 / 弧光 / 气体）、全挂一台、没有转换程序配置（照旧按点表全量）。"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lsa_check as lc  # noqa: E402

lc.SPEC = lc.load_spec()
ok = bad = 0


def check(cond, what, detail=''):
    global ok, bad
    if cond:
        ok += 1
        print('  ✓ ' + what)
    else:
        bad += 1
        print('  ✗ ' + what + (('  —— ' + detail) if detail else ''))


def sensor_yaml(name, typ, dev, slave, enabled, keys):
    regs = ''.join('  r%d:\n    address: 0x%04X\n    key: "%s"         # 注释\n' % (i, i, k) for i, k in enumerate(keys))
    return ('# 同事配置的写法\nsensor:\n  name: "%s"\n  type: "%s"\n  device: "%s"        # 设备名\n  slave_id: %d\n  enabled: %s\n\n'
            'registers:\n%s' % (name, typ, dev, slave, 'true' if enabled else 'false', regs))


def make_conf(files):
    d = tempfile.mkdtemp(prefix='lsa-conv-')
    os.makedirs(os.path.join(d, 'sensors'))
    for f, text in files.items():
        with open(os.path.join(d, 'sensors', f), 'w', encoding='utf-8') as fh:
            fh.write(text)
    return d


SPLIT = {
    'temperature.yaml': sensor_yaml('environment', 'temperature_humidity', 'SAM-AH03-A', 4, True, ['env.rh', 'env.t']),
    'pd.yaml': sensor_yaml('pd', 'partial_discharge', 'SAM-AH03-B', 2, True, ['us.amp', 'us.cnt', 'tev.amp']),
    'arc_light.yaml': sensor_yaml('arc', 'arc_light', 'SAM-AH03-B', 5, True, ['uv.int']),
    'gas.yaml': sensor_yaml('gas', 'smoke', 'SAM-AH03-B', 3, True, ['smoke.ppm']),
    'infrared.yaml': sensor_yaml('ir', 'infrared', 'SAM-AH03-B', 1, False, ['ir.t_max', 'ir.t_avg']),
}


def run(devices, expect, feed):
    """按 feed（设备名 → 发的量）每 2 s 发一轮、发 60 s，然后看「一直没收到」的问题"""
    t = [1_792_000_000_000]
    lc.now_ms = lambda: t[0]

    class A:
        raw = quiet = lan = False
        every = 0
    ck = lc.Checker(A(), devices, expect)
    ck.started = t[0]
    for _ in range(31):
        for dev, keys in feed.items():
            vals = {k: (12.3 if k not in ('us.cnt',) else 1) for k in keys}
            ck.on_message('lsa/%s/telemetry' % dev, 1, False, {}, json.dumps({'ts': t[0], 'values': vals}).encode())
        t[0] += 2000
    ck.tick()
    miss = {}
    for (level, dev, code, key) in ck.issues:
        if code == 'missing':
            miss.setdefault(dev, set()).add(key)
        elif code == 'absent':
            miss.setdefault(dev, set()).add('<一条都没收到>')
    return miss


print('1. 解析（同事配置的写法）')
d = make_conf(SPLIT)
exp, probs = lc.read_conv_expect(d)
check(exp == {'SAM-AH03-A': {'env.t', 'env.rh'}, 'SAM-AH03-B': {'us.amp', 'us.cnt', 'tev.amp', 'uv.int', 'smoke.ppm'}} and not probs,
      '打开的传感器按 device 归，关着的（红外）不算；行尾注释、引号都去掉', repr(exp))
check(lc.read_conv_expect(os.path.join(d, 'sensors'))[0] == exp, '给 sensors/ 目录本身也认')
nokey = make_conf({'gas.yaml': '\nsensor:\n  type: smoke\n  device: SAM-X-A\n  slave_id: 3\n  enabled: true\nregisters:\n  ppm:\n    address: 0x16\n'})
check(lc.read_conv_expect(nokey)[0] == {'SAM-X-A': {'smoke.ppm'}}, '寄存器没写 key：按 type 兜底（smoke → smoke.ppm）')
nodev = make_conf({'pd.yaml': '\nsensor:\n  type: partial_discharge\n  slave_id: 2\n  enabled: true\nregisters:\n  a:\n    key: us.amp\n'})
e2, p2 = lc.read_conv_expect(nodev)
check(e2 == {} and any('没写 device' in x for x in p2), '打开了但没写 device：报问题、不算')
check(lc.read_conv_expect(os.path.join(d, 'nope'))[0] is None, '没有配置目录：None（照旧全量）')

devs = {'SAM-AH03-A': 'sam', 'SAM-AH03-B': 'sam'}
feed_split = {'SAM-AH03-A': ['env.t', 'env.rh'], 'SAM-AH03-B': ['us.amp', 'us.cnt', 'tev.amp', 'uv.int', 'smoke.ppm']}

print('2. 分挂两台（A 只温湿度，B 局放 / 弧光 / 气体）')
m = run(devs, exp, feed_split)
check(not m, '给了 --conv：两台都不报「一直没收到」', repr(m))
m0 = run(devs, None, feed_split)
check('us.amp' in m0.get('SAM-AH03-A', set()) and 'env.t' in m0.get('SAM-AH03-B', set()), '对照（不给 --conv，老口径）：A 报缺局放、B 报缺温湿度 —— 就是 W1 的误报', repr(m0))
m2 = run(devs, exp, {'SAM-AH03-A': ['env.t', 'env.rh'], 'SAM-AH03-B': ['us.amp', 'us.cnt', 'uv.int', 'smoke.ppm']})
check(m2 == {'SAM-AH03-B': {'tev.amp'}}, '给了 --conv、B 真的少发 tev.amp：照样报（挂上来的传感器缺量不会被放过）', repr(m2))

print('3. 全挂一台（舱室 EG，S19）')
one = make_conf({f: t.replace('SAM-AH03-A', 'SAM-AH03-B') for f, t in SPLIT.items()})
exp1, _ = lc.read_conv_expect(one)
check(set(exp1) == {'SAM-AH03-B'} and {'env.t', 'us.amp', 'smoke.ppm'} <= exp1['SAM-AH03-B'], '五路都在 SAM-AH03-B 下')
m3 = run({'SAM-AH03-B': 'sam'}, exp1, {'SAM-AH03-B': feed_split['SAM-AH03-A'] + feed_split['SAM-AH03-B']})
check(not m3, '全都发了：不报', repr(m3))
m4 = run({'SAM-AH03-B': 'sam'}, exp1, {'SAM-AH03-B': ['env.t', 'us.amp', 'us.cnt', 'tev.amp', 'uv.int', 'smoke.ppm']})
check(m4 == {'SAM-AH03-B': {'env.rh'}}, '少发 env.rh：报', repr(m4))

print('4. 没有转换程序配置（不给 --conv / 目录里没有能读的文件）：照旧按点表全量')
m5 = run(devs, None, {'SAM-AH03-A': feed_split['SAM-AH03-A'] + feed_split['SAM-AH03-B']})
check('SAM-AH03-A' not in m5 or 'us.amp' not in m5['SAM-AH03-A'], 'A 全发了的量不报')
check(m5.get('SAM-AH03-B') == {'<一条都没收到>'}, 'B 什么都没发：报「30 s 内一条都没收到」（同老口径）', repr(m5.get('SAM-AH03-B')))
m6 = run(devs, exp, {'SAM-AH03-A': feed_split['SAM-AH03-A']})
check(not m6.get('SAM-AH03-A') and m6.get('SAM-AH03-B') == {'<一条都没收到>'}, '给了 --conv、B 一条都没来：A 不报，B 报「30 s 内一条都没收到」', repr(m6))

if len(sys.argv) > 1:
    print('5. 拿真配置核一遍解析（%s）' % sys.argv[1])
    e, p = lc.read_conv_expect(sys.argv[1])
    for n in sorted(e or {}):
        print('    %s：%s' % (n, '、'.join(sorted(e[n]))))
    check(bool(e), '真配置解析出了设备', repr(p))

print('\n%d 项通过，%d 项失败' % (ok, bad))
sys.exit(1 if bad else 0)
