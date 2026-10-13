#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Modbus RTU 从站模拟器（转换程序联调用，conv-kit v0.7）：在一个虚拟串口（pty）上模拟转换程序轮询的 5 台 RS485 传感器。
寄存器布局取自转换程序驱动里的「实测报文」注释与 ALS10 协议 V0.1.0。只用 Python 标准库（3.8+），**只能在 Linux 上跑**（要 pty）。

用法：
  python3 sim.py /tmp/ttyV0          # 建虚拟串口，链接到 /tmp/ttyV0，一直跑到 Ctrl+C
然后把转换程序的串口改成 /tmp/ttyV0（9600 8N1），另开窗口跑检查工具：
  python3 lsa_check.py --cab AH03 --duration 260 --report 联调报告.md
模拟器与转换程序要在同一台机器 / 同一个容器里（pty 是本机的）；用容器跑转换程序时，把模拟器也放进那个容器跑。

从站（地址、功能码、寄存器）：
  1  FC03  红外：0x4F 最高 / 0x50 最低 / 0x51 平均（×0.1 ℃）—— G4 起 SAM 不再发 ir.*，正确的程序不该再读 / 发
  2  FC03  局放：0 放电量（×0.1 dBμV）/ 1 次数 / 2 类型 / 3 等级；8 地电波、12 特高频读出 187 / 269 = 这一路没装，不要发
  3  FC03  气体：0x16 ppm、0x17 量程 1000（量程不用发）
  4  FC03  温湿度：0 湿度 ×0.1、1 温度 ×0.1（有符号）
  5  FC04  ALS10 弧光：0 设备状态、3 弧光等级、6 峰值；0x100–0x107 最近一次事件（序号、类型、…、峰值 ×0.01 %、…、持续 ms）

时间线（从模拟器启动算起，秒）—— 每一段对应检查工具 / EG 该看到的现象：
   0– 40  全部正常
  40      弧光：上电 / 复位事件（类型 3，峰值 0）—— 正确的转换程序只记日志，不发 uv.pulse
  70      弧光：真放电事件（类型 1，峰值 72.35 %，21 ms）—— 发 uv.pulse，同一条 uv.int = 72.35
  90–130  局放（从站 2）不应答 —— 只有局放这台的 dev.fails 往上数、停发局放量；别的传感器不能把它清 0
 100–160  气体 150 ppm
 140–220  温湿度（从站 4）不应答 —— 同上
"""
import os
import sys
import time
import tty

T0 = time.monotonic()


def el():
    return time.monotonic() - T0


def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def log(*a):
    print(f'[sim {el():6.1f}s]', *a, flush=True)


class Arc:
    def __init__(self):
        self.seq = 5
        self.ev = [0] * 8
        self.done = set()

    def tick(self):
        t = el()
        if t >= 40 and 'boot' not in self.done:
            self.done.add('boot')
            self.seq += 1
            # 序号、类型 3 上电、开始运行秒数 0、峰值 0、持续 0、故障快照 0
            self.ev = [self.seq, 3, 0, 0, 0, 0, 0, 0]
            log('弧光事件：类型 3（上电 / 复位），序号', self.seq)
        if t >= 70 and 'arc' not in self.done:
            self.done.add('arc')
            self.seq += 1
            self.ev = [self.seq, 1, 0, 1234, 7235, 0, 21, 0]
            log('弧光事件：类型 1（弧光告警），峰值 72.35 %，21 ms，序号', self.seq)


ARC = Arc()


def regs(slave: int, fc: int):
    """返回 {地址: 值}；None = 不应答"""
    t = el()
    if slave == 1 and fc == 3:  # 红外：0x4F 最高 / 0x50 最低 / 0x51 平均（×0.1 ℃）
        return {0x4F: 291 + int(t) % 5, 0x50: 265, 0x51: 277}
    if slave == 2 and fc == 3:  # 局放：0 放电量 ×0.1 dBμV / 1 次数 / 2 类型 / 3 等级；8 / 12 地电波、特高频（没装：187 / 269）
        if 90 <= t < 130:
            return None
        return {0: 258, 1: 4, 2: 1, 3: 0, 8: 187, 12: 269}
    if slave == 3 and fc == 3:  # 气体：0x16 ppm、0x17 量程 1000
        return {0x16: 150 if 100 <= t < 160 else 6, 0x17: 1000}
    if slave == 4 and fc == 3:  # 温湿度：0 湿度 ×0.1、1 温度 ×0.1（有符号）
        if 140 <= t < 220:
            return None
        return {0: 349, 1: 270}
    if slave == 5 and fc == 4:  # ALS10：0 设备状态（READY|MEASURING）、3 弧光等级、6 峰值；0x100–0x107 最近一次事件
        ARC.tick()
        r = {0: 0x0003, 1: 0, 2: 0, 3: 3, 4: 0, 5: 0, 6: 12}
        for i, v in enumerate(ARC.ev):
            r[0x100 + i] = v
        return r
    return None


def main():
    link = sys.argv[1]
    master, slave_fd = os.openpty()
    tty.setraw(master)
    tty.setraw(slave_fd)
    name = os.ttyname(slave_fd)
    if os.path.lexists(link):
        os.unlink(link)
    os.symlink(name, link)
    log('pty', name, '→', link)
    buf = b''
    while True:
        chunk = os.read(master, 256)
        buf += chunk
        while len(buf) >= 8:
            frame, buf = buf[:8], buf[8:]
            if crc16(frame[:6]) != int.from_bytes(frame[6:8], 'little'):
                log('CRC 错，丢弃', frame.hex())
                buf = b''
                break
            sid, fc = frame[0], frame[1]
            addr = int.from_bytes(frame[2:4], 'big')
            cnt = int.from_bytes(frame[4:6], 'big')
            r = regs(sid, fc)
            if r is None:
                continue  # 不应答
            data = b''.join(int(r.get(addr + i, 0) & 0xFFFF).to_bytes(2, 'big') for i in range(cnt))
            body = bytes([sid, fc, len(data)]) + data
            os.write(master, body + crc16(body).to_bytes(2, 'little'))


if __name__ == '__main__':
    main()
