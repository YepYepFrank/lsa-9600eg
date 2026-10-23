#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""lsa_check 按转换程序配置算预期测点（W1，用户 2026-10-20 选 ①）的自检。只用标准库：
  python3 test_expect.py [同事配置的 sensors 目录，可选：再拿真配置核一遍解析]
三种情况：分挂两台（A 只温湿度、B 局放 / 弧光 / 气体）、全挂一台、没有转换程序配置（照旧按点表全量）。
另：1.2 的 q 标 absent（装置报告没装，v0.8，现场 AH01-B）与 --applied（本单元能力清单）。"""
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


def run(devices, expect, feed, applied=None, q=None, infos=None):
    """按 feed（设备名 → 发的量）每 2 s 发一轮、发 60 s，然后看「一直没收到」的问题。
    q：{设备名: q 的 JSON 串}，跟着每条发；infos：给个 list 就把「建议」级的问题文字放进去"""
    t = [1_792_000_000_000]
    lc.now_ms = lambda: t[0]

    class A:
        raw = quiet = lan = False
        every = 0
    ck = lc.Checker(A(), devices, expect, applied)
    ck.started = t[0]
    for _ in range(31):
        for dev, keys in feed.items():
            vals = {k: (12.3 if k not in ('us.cnt',) else 1) for k in keys}
            if q and dev in q:
                vals['q'] = q[dev]
            ck.on_message('lsa/%s/telemetry' % dev, 1, False, {}, json.dumps({'ts': t[0], 'values': vals}).encode())
        t[0] += 2000
    ck.tick()
    miss = {}
    for (level, dev, code, key) in ck.issues:
        if code == 'missing':
            miss.setdefault(dev, set()).add(key)
        elif code == 'absent':
            miss.setdefault(dev, set()).add('<一条都没收到>')
    if infos is not None:
        infos.extend(v[1] for (level, dev, code, key), v in ck.issues.items() if level == 'INFO' and code in ('absent-ch', 'cap-pending'))
    if any(code == 'q-val' for (_l, _d, code, _k) in ck.issues):
        miss.setdefault('<q-val>', set()).add('q 里有不认识的码')
    return miss


print('1. 解析（同事配置的写法）')
d = make_conf(SPLIT)
exp, probs = lc.read_conv_expect(d)
check(exp == {'SAM-AH03-A': {'env.t', 'env.rh'}, 'SAM-AH03-B': {'us.amp', 'us.cnt', 'uv.int', 'smoke.ppm'}} and not probs,
      '打开的传感器按 device 归，关着的（红外）不算；行尾注释、引号都去掉；寄存器写了 tev.amp 也不进预期（0.19.0：本项目局放只有超声）', repr(exp))
pdfull = make_conf({'pd.yaml': sensor_yaml('pd', 'partial_discharge', 'SAM-X-A', 2, True, ['us.amp', 'us.cnt', 'us.type', 'us.level', 'tev.amp', 'tev.level', 'uhf.amp', 'uhf.level'])})
check(lc.read_conv_expect(pdfull)[0] == {'SAM-X-A': {'us.amp', 'us.cnt', 'us.type', 'us.level'}}, '同事的 pd.yaml 写全了地电波 / 特高频的 key：只留超声四个')
pdnokey = make_conf({'pd.yaml': '\nsensor:\n  type: partial_discharge\n  device: SAM-X-A\n  slave_id: 2\n  enabled: true\nregisters:\n  a:\n    address: 0x0\n'})
check(lc.read_conv_expect(pdnokey)[0] == {'SAM-X-A': {'us.amp', 'us.cnt', 'us.type', 'us.level'}}, '局放寄存器没写 key：按类型兜底也只有超声')
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
m2 = run(devs, exp, {'SAM-AH03-A': ['env.t', 'env.rh'], 'SAM-AH03-B': ['us.amp', 'tev.amp', 'uv.int', 'smoke.ppm']})
check(m2 == {'SAM-AH03-B': {'us.cnt'}}, '给了 --conv、B 真的少发 us.cnt：照样报（挂上来的传感器缺量不会被放过）', repr(m2))

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

caps_keys = {'pdAmplitude': ['SAM:us.amp'], 'pdCount': ['SAM:us.cnt'], 'tev': ['SAM:tev.*'], 'uhf': ['SAM:uhf.*']}
S19 = {'caps': {'pdAmplitude': 'confirmed', 'pdCount': 'confirmed', 'tev': 'confirmed', 'uhf': 'unsupported'}, 'capKeys': caps_keys}
pd_only = {'SAM-AH01-B': {'us.amp', 'us.cnt', 'tev.amp', 'tev.level'}}
feed_us = {'SAM-AH01-B': ['us.amp', 'us.cnt']}

print('5. 点表全局缺省（地电波 / 特高频不支持；0.8.1：SAM 红外也不支持 —— 本项目 SAM 没有自带红外）')
infos0 = []
m00 = run({'SAM-AH01-B': 'sam'}, pd_only, feed_us, infos=infos0)
check(not m00, '不给 --applied、地电波一直没来：按全局缺省「待定」不报缺', repr(m00))
check(lc.keydefs('sam')['tev.amp'].get('capState') == 'unsupported' and lc.keydefs('sam')['uhf.amp'].get('capState') == 'unsupported' and lc.keydefs('sam')['ir.t_max'].get('capState') == 'unsupported', 'spec.json：tev.* / uhf.* unsupported，ir.t_* unsupported（0.8.1）')

print('5b. 转换程序 q 标 absent（0.19.0 的转换程序起会发；本单元地电波 confirmed，S19 那样）')
m7 = run({'SAM-AH01-B': 'sam'}, pd_only, feed_us, applied=S19)
check(m7 == {'SAM-AH01-B': {'tev.amp'}}, '对照：没标 absent（老转换程序）—— 报「一直没收到 tev.amp」（tev.level 是可选量），现场以为接错线', repr(m7))
infos = []
m8 = run({'SAM-AH01-B': 'sam'}, pd_only, feed_us, applied=S19, q={'SAM-AH01-B': json.dumps({'tev.amp': 'absent', 'tev.level': 'absent'})}, infos=infos)
check(not m8, '标了 absent：不报错、q 的码认得（absent 在合法取值里）', repr(m8))
check(len(infos) == 1 and '读出 187 = 没装地电波' in infos[0] and '「地电波」改成不支持' in infos[0] and 'tev.amp、tev.level' in infos[0],
      '给一条建议（地电波一条，不按 key 重复）：%s' % (infos[0] if infos else '（没有）'))

print('6. --applied：按本单元的能力清单（子站 0.18.3 起地电波缺省 pending，S19 由本站模型 confirmed）')
appl_dir = tempfile.mkdtemp(prefix='lsa-applied-')
ap_path = os.path.join(appl_dir, 'applied-config.json')
with open(ap_path, 'w', encoding='utf-8') as fh:
    json.dump({'version': 'c-1', 'caps': {'caps': {'pdAmplitude': 'confirmed', 'pdCount': 'confirmed', 'tev': 'pending', 'uhf': 'unsupported'}, 'capKeys': caps_keys}}, fh)
ap, prob = lc.read_applied(ap_path)
check(ap is not None and prob is None and lc.key_cap_state(ap, 'SAM-AH01-B', 'tev.level') == 'pending' and lc.key_cap_state(ap, 'SAM-AH01-B', 'env.t') is None,
      '读 applied-config.json：tev.level → pending（SAM:tev.* 前缀匹配），env.t 没有对应能力 → None', repr(prob))
infos9 = []
m9 = run({'SAM-AH01-B': 'sam'}, pd_only, feed_us, applied=ap, infos=infos9)
check(not m9, '本单元地电波 pending、一直没来：不报（装了才发）', repr(m9))
check(len(infos9) == 1 and '「待定」' in infos9[0] and '不算缺' in infos9[0], 'pending 给一条建议：%s' % (infos9[0] if infos9 else '（没有）'))
ap_uns = {'caps': dict(ap['caps'], tev='unsupported'), 'capKeys': caps_keys}
infos_u = []
m_u = run({'SAM-AH01-B': 'sam'}, pd_only, feed_us, applied=ap_uns, infos=infos_u)
check(not m_u and not infos_u, '现场 AH01-B：本单元地电波 unsupported（c-1021-4）—— 不报缺、也不提', repr((m_u, infos_u)))
ap_conf = {'caps': dict(ap['caps'], tev='confirmed'), 'capKeys': caps_keys}
m10 = run({'SAM-AH01-B': 'sam'}, pd_only, feed_us, applied=ap_conf)
check(m10 == {'SAM-AH01-B': {'tev.amp'}}, '本单元地电波 confirmed（S19）、一直没来也没标 absent：照报（全局缺省 pending 也不放过）', repr(m10))
none_path = os.path.join(appl_dir, 'none.json')
check(lc.read_applied(none_path)[0] is None and '没有' in lc.read_applied(none_path)[1], '没有 applied-config.json：None，按点表全局缺省')
with open(none_path, 'w', encoding='utf-8') as fh:
    json.dump({'version': 'c-1', 'caps': None}, fh)
check(lc.read_applied(none_path)[0] is None and '老子站' in lc.read_applied(none_path)[1], '子站没下发过能力（caps 为 null）：None')

if len(sys.argv) > 1:
    print('7. 拿真配置核一遍解析（%s）' % sys.argv[1])
    e, p = lc.read_conv_expect(sys.argv[1])
    for n in sorted(e or {}):
        print('    %s：%s' % (n, '、'.join(sorted(e[n]))))
    check(bool(e), '真配置解析出了设备', repr(p))

print('\n%d 项通过，%d 项失败' % (ok, bad))
sys.exit(1 if bad else 0)
