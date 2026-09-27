/** 只供开发预览（?demo=1，仅 Vite 开发服务器）的内存数据，不访问采集设备、子站或真实管理接口。
 *  领导 80e01ad 原样的演示数据；EG 外壳轮询的 status / diag / components / catalog 补齐成现在接口的形状。 */
export function demoApi(path: string, method: string): unknown {
  if (method !== 'GET') throw new Error('演示模式不执行设备操作')
  const now = Date.now()
  switch (path.split('?')[0]) {
    case 'status':
      return {
        eg: 'EG-AH03（演示）', version: 'demo', cabinet: { code: 'AH03', name: '1#出线柜', group: 'mv', kind: '出线', rated: 630, rooms: ['断路器室', '电缆室'] },
        station: { name: 'SP-1', label: '本地界面预览' }, sp: { host: '未配置' }, uptimeSec: 14760, rssMb: 86,
        state: 'online', bus: { url: '模拟本机总线', connected: true, msgs: 125680 },
        devices: [
          { name: 'SAM-AH03', kind: 'sam', label: '柜内 SAM', keys: 18 },
          { name: 'METER-AH03', kind: 'meter', label: '多功能电力仪表', keys: 24 },
          { name: 'CAM-AH03', kind: 'camera', label: '双光摄像头', keys: 6 },
        ].map(d => ({ ...d, msgs: 3600, lastTs: now - 1000, ageSec: 1, dead: false, q: {}, south: { req: 3600, timeout: 0, rate: 100 }, southBySource: false, rated: null, epBackwards: 0 })),
        unknownDevices: [],
      }
    case 'components':
      return [
        { key: 'agent', label: 'eg-agent（演示）', container: null, state: 'running', startedAt: now - 14760_000, restarts: 0, memMb: 86, cpuPct: 1.2, restartable: false },
        { key: 'mosquitto', label: 'MQTT（演示）', container: null, state: 'running', startedAt: now - 14760_000, restarts: 0, memMb: 12, cpuPct: 0.3, restartable: false },
      ]
    case 'diag':
      return {
        now, bus: { url: '模拟本机总线', connected: true },
        uplink: { state: 'none', text: '未连接子站 · 本地演示' },
        sp: { host: '未配置', latMs: null, lossPct: null },
        clock: { server: '未检测', offsetMs: null },
        devices: { dead: [], unknown: [] },
      }
    case 'catalog':
      return { devices: {}, common: [] }
    default:
      throw new Error(`演示模式不支持此接口：${path}`)
  }
}
