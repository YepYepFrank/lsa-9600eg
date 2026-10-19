"""补丁 G（0007，通用 Modbus 电表）的直接检验：不碰串口，用假的 Modbus 客户端按寄存器表回数，看驱动解析出来的 el.* 对不对。
   docker run --rm --network none -v <打了补丁的仓库>:/src -v <本目录>:/t -e PYTHONPATH=/src:/app/deps --entrypoint python3 lsa-eg-conv:1.1.1-p6 /t/test_g.py
   （转换程序镜像里有 python 与依赖；/src 是打了 0001–0007 的同事仓库，config/sensors/meter.yaml 是占位寄存器表）"""
import asyncio
import json
import os
import struct
import sys

import yaml

sys.argv = ['x']
from src.drivers.meter import ModbusMeterDriver  # noqa: E402

fails = 0
n = 0


def ok(cond, what):
    global fails, n
    n += 1
    print(('  ✓ ' if cond else '  ✗ ') + what)
    if not cond:
        fails += 1


def f32(v, big=True):
    hi, lo = struct.unpack('>HH', struct.pack('>f', v))
    return [hi, lo] if big else [lo, hi]


def u32(v, big=True):
    hi, lo = (v >> 16) & 0xFFFF, v & 0xFFFF
    return [hi, lo] if big else [lo, hi]


class FakeClient:
    """按 {地址: 字} 回数；fail = 这些段起始地址不应答；记下每次读了哪段、用的功能码"""

    def __init__(self, words, fail=()):
        self.words, self.fail, self.calls = words, set(fail), []

    async def _read(self, fc, slave_id, address, count):
        self.calls.append((fc, slave_id, address, count))
        if address in self.fail:
            return None
        return [self.words.get(address + i, 0) for i in range(count)]

    async def read_holding_registers(self, slave_id, address, count=1):
        return await self._read(3, slave_id, address, count)

    async def read_input_registers(self, slave_id, address, count=1):
        return await self._read(4, slave_id, address, count)


def placeholder_words(big=True):
    w = {}
    vals = {0x00: 57.74, 0x02: 57.70, 0x04: 57.80, 0x06: 2.5, 0x08: 2.4, 0x0A: 2.6, 0x0C: 0.43, 0x0E: 0.12,
            0x10: 0.45, 0x12: 0.96, 0x14: 50.01, 0x16: 2.1, 0x18: 6.3}
    for a, v in vals.items():
        for i, x in enumerate(f32(v, big)):
            w[a + i] = x
    for i, x in enumerate(u32(123456, big)):
        w[0x1A + i] = x                                   # Ep 1234.56 kWh
    for i in range(90):
        w[0x100 + i] = 100 + i                            # 电压谐波 1.00 % 起
        w[0x200 + i] = 300 + i                            # 电流谐波 3.00 % 起
    return w


here = os.path.dirname(os.path.abspath(__file__))
CFG = yaml.safe_load(open(os.environ.get('METER_YAML', '/src/config/sensors/meter.yaml'), encoding='utf-8'))
CFG['sensor']['enabled'] = True


async def main():
    print('== 1. 占位寄存器表，高字在前：各量解析')
    c = FakeClient(placeholder_words())
    d = ModbusMeterDriver(c, CFG)
    v = await d.read()
    ok(v is not None, '读到了')
    ok(abs(v['el.Ua'] - 57.74) < 1e-3 and abs(v['el.Ic'] - 2.6) < 1e-3, 'el.Ua 57.74、el.Ic 2.6（float32）')
    ok(abs(v['el.P'] - 0.43) < 1e-3 and abs(v['el.PF'] - 0.96) < 1e-3 and abs(v['el.F'] - 50.01) < 1e-3, 'el.P / el.PF / el.F')
    ok(v['el.Ep'] == 1234.56, 'el.Ep = 1234.56（uint32 × 0.01）')
    hu = json.loads(v['el.hu.A'])
    ok(isinstance(v['el.hu.A'], str) and len(hu) == 30 and hu[0] == 1.0 and hu[29] == 1.29, 'el.hu.A：JSON 字符串、30 个、1.00–1.29')
    ok(json.loads(v['el.hi.C'])[0] == 3.6, 'el.hi.C 从 0x023C 起（3.60）')
    ok(set(k for k in v if k.startswith('el.')) == set(CFG['registers']), '表里 %d 个量都出来了' % len(CFG['registers']))
    ok(all(fc == 3 and sid == 6 for fc, sid, _, _ in c.calls) and len(c.calls) == 3, '从站 6、FC03、读了 3 段')

    print('== 2. 慢档（every: 60）：紧接着再读一次，谐波两段不读、不发')
    c.calls.clear()
    v2 = await d.read()
    ok(len(c.calls) == 1 and c.calls[0][2] == 0, '只读了第一段')
    ok('el.Ua' in v2 and 'el.hu.A' not in v2 and 'el.hi.A' not in v2, '快档的量照发，谐波这轮不发')

    print('== 3. 低字在前（word_order: little）')
    cfg = dict(CFG, word_order='little')
    v3 = await ModbusMeterDriver(FakeClient(placeholder_words(big=False)), cfg).read()
    ok(abs(v3['el.Ua'] - 57.74) < 1e-3 and v3['el.Ep'] == 1234.56, '同样解析出 57.74 / 1234.56')

    print('== 4. 表内设了变比（ratio pt 100 / ct 40）：除回二次值')
    words = placeholder_words()
    for i, x in enumerate(f32(5774.0)):
        words[0x00 + i] = x
    for i, x in enumerate(f32(100.0)):
        words[0x06 + i] = x
    for i, x in enumerate(f32(1720.0)):
        words[0x0C + i] = x
    v4 = await ModbusMeterDriver(FakeClient(words), dict(CFG, ratio={'pt': 100, 'ct': 40})).read()
    ok(abs(v4['el.Ua'] - 57.74) < 1e-3, 'el.Ua 5774 ÷ PT 100 = 57.74')
    ok(abs(v4['el.Ia'] - 2.5) < 1e-3, 'el.Ia 100 ÷ CT 40 = 2.5')
    ok(abs(v4['el.P'] - 0.43) < 1e-3, 'el.P 1720 ÷ (100 × 40) = 0.43')
    ok(abs(v4['el.PF'] - 0.96) < 1e-3 and abs(v4['el.F'] - 50.01) < 1e-3, '功率因数、频率不除')

    print('== 5. 有一段不应答：这一轮整台算失败（返回 None），不发半截数')
    ok(await ModbusMeterDriver(FakeClient(placeholder_words(), fail={0x100}), CFG).read() is None, '谐波段不应答 → None')

    print('== 6. 寄存器表写错的项：跳过，别的照常')
    cfg6 = json.loads(json.dumps(CFG))
    cfg6['registers']['el.bad1'] = {'address': 0x0300, 'type': 'float32'}
    cfg6['registers']['el.bad2'] = {'address': 0x0000, 'type': 'double'}
    cfg6['registers']['el.bad3'] = {'address': 0x0000, 'type': 'float32', 'ratio': 'kv'}
    cfg6['blocks'].append({'address': 0x400, 'count': 200})
    d6 = ModbusMeterDriver(FakeClient(placeholder_words()), cfg6)
    v6 = await d6.read()
    ok(v6 is not None and 'el.bad1' not in v6 and 'el.bad2' not in v6 and 'el.bad3' not in v6 and 'el.Ua' in v6, '三个错项都跳过、el.Ua 照发')
    ok(len(d6._blocks) == 3, '超过 125 个寄存器的段跳过')

    print('== 7. FC04、有符号整数')
    cfg7 = {'sensor': {'name': 'meter', 'slave_id': 7, 'enabled': True, 'device': 'PM-X'}, 'function': 4,
            'blocks': [{'address': 0, 'count': 3}],
            'registers': {'el.P': {'address': 0, 'type': 'int16', 'scale': 0.1}, 'el.Q': {'address': 1, 'type': 'int32', 'scale': 0.001}}}
    c7 = FakeClient({0: 0xFFF6, 1: 0xFFFF, 2: 0xFC18})   # int16 -10 → -1.0；int32 0xFFFFFC18 = -1000 → -1.0
    v7 = await ModbusMeterDriver(c7, cfg7).read()
    ok(c7.calls[0][0] == 4 and c7.calls[0][1] == 7, 'FC04、从站 7')
    ok(v7['el.P'] == -1.0 and v7['el.Q'] == -1.0, 'int16 −10 × 0.1 = −1.0；int32 −1000 × 0.001 = −1.0')

    print()
    print('== 通过（%d 项）' % n if not fails else '== 有失败项（%d / %d）' % (fails, n))
    sys.exit(1 if fails else 0)


asyncio.run(main())
