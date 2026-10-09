<#
转换程序测试总线（Windows）：一键装 / 卸 EG 本机 Mosquitto（与 EG 上同版本、同配置、同端口 127.0.0.1:1884）。说明见同目录 README.md。

  powershell -ExecutionPolicy Bypass -File install.ps1              装：Docker Desktop 在跑就用容器（eclipse-mosquitto 2.1.2，与 EG 一致），否则用本机装的 Mosquitto
  powershell -ExecutionPolicy Bypass -File install.ps1 -Lan         同上，但听 0.0.0.0（局域网里别的机器也能连）
  powershell -ExecutionPolicy Bypass -File install.ps1 -Native      强制用本机 Mosquitto（没装会用 winget 装）
  powershell -ExecutionPolicy Bypass -File install.ps1 -Port 1885   换端口（缺省 1884）
  powershell -ExecutionPolicy Bypass -File install.ps1 -Status      看状态
  powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall   卸掉（停容器 / 停本机进程，删本套件的数据）

本机 Mosquitto 方式不注册成服务：由本脚本在后台起一个 mosquitto.exe，重启电脑后再跑一次本脚本即可。
#>
param(
  [switch]$Lan,
  [switch]$Native,
  [switch]$Docker,
  [int]$Port = 1884,
  [switch]$Status,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$Kit = Split-Path -Parent $MyInvocation.MyCommand.Path
$Ver = '2.1.2'
$Bind = if ($Lan) { '0.0.0.0' } else { '127.0.0.1' }
$DataDir = Join-Path $Kit 'data'
$NativeConf = Join-Path $DataDir 'mosquitto-win.conf'
$PidFile = Join-Path $DataDir 'mosquitto.pid'

function Say($m) { Write-Host "==> $m" -ForegroundColor Green }
function Warn($m) { Write-Host "!! $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "xx $m" -ForegroundColor Red; exit 1 }

function Test-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
  $null = & docker info 2>$null
  if ($LASTEXITCODE -ne 0) { return $false }
  $null = & docker compose version 2>$null
  return ($LASTEXITCODE -eq 0)
}
function Get-Python {
  foreach ($c in @(@('py', '-3'), @('python'), @('python3'))) {
    if (Get-Command $c[0] -ErrorAction SilentlyContinue) {
      $args2 = @()
      if ($c.Count -gt 1) { $args2 = $c[1..($c.Count - 1)] }
      $v = & $c[0] @args2 -c 'import sys;print(sys.version_info[:2]>=(3,8))' 2>$null
      if ($v -eq 'True') { return , $c }
    }
  }
  return $null
}
function Test-Listening { return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) }
function Test-DockerUp {
  if (-not (Test-Docker)) { return $false }
  $n = & docker ps --format '{{.Names}}' 2>$null
  return ($n -contains 'lsa-conv-mosquitto')
}
function Get-NativeProc {
  if (-not (Test-Path $PidFile)) { return $null }
  $p = Get-Process -Id ([int](Get-Content $PidFile)) -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq 'mosquitto') { return $p }
  return $null
}
function Find-Mosquitto {
  $c = Get-Command mosquitto -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($d in @("$env:ProgramFiles\mosquitto", "${env:ProgramFiles(x86)}\mosquitto")) {
    if (Test-Path "$d\mosquitto.exe") { return "$d\mosquitto.exe" }
  }
  return $null
}

if ($Status) {
  if (Test-DockerUp) { Say "容器 lsa-conv-mosquitto 在跑：$(& docker port lsa-conv-mosquitto 1883/tcp)"; exit 0 }
  $p = Get-NativeProc
  if ($p) { Say "本机 mosquitto.exe 在跑（PID $($p.Id)），配置 $NativeConf"; exit 0 }
  Warn '没装（或没在跑）'; exit 1
}

if ($Uninstall) {
  if (Test-Docker) {
    $n = & docker ps -a --format '{{.Names}}' 2>$null
    if ($n -contains 'lsa-conv-mosquitto') {
      & docker compose -p lsa-conv-kit -f "$Kit\compose.yaml" down -v
      Say '容器与数据卷已删'
    }
  }
  $p = Get-NativeProc
  if ($p) { Stop-Process -Id $p.Id -Force; Say "已停本机 mosquitto.exe（PID $($p.Id)）" }
  if (Test-Path $DataDir) { Remove-Item -Recurse -Force $DataDir; Say "已删 $DataDir" }
  exit 0
}

$UseDocker = $false
if ($Docker) { if (-not (Test-Docker)) { Die 'Docker Desktop 没在跑（docker info 失败）；先启动它，或改用 -Native' }; $UseDocker = $true }
elseif (-not $Native) { $UseDocker = Test-Docker }

if ($UseDocker) {
  Say "安装方式：容器 eclipse-mosquitto:$Ver，监听 ${Bind}:$Port"
  $null = & docker image inspect "eclipse-mosquitto:$Ver" 2>$null
  if ($LASTEXITCODE -ne 0) {
    $tar = Join-Path $Kit "images\eclipse-mosquitto-$Ver.tar"
    if (Test-Path $tar) { Say "导入离线镜像 $tar"; & docker load -i $tar }
    else { Say "拉镜像 eclipse-mosquitto:$Ver"; & docker pull "eclipse-mosquitto:$Ver"; if ($LASTEXITCODE -ne 0) { Die '拉不到镜像（没外网？）：把 images\eclipse-mosquitto-2.1.2.tar 拷过来，或改用 -Native' } }
  }
  if (-not (Test-DockerUp) -and (Test-Listening)) { Die "端口 $Port 已被别的程序占用（Get-NetTCPConnection -LocalPort $Port 看是谁），换一个：-Port 1885" }
  $env:LSA_BUS_BIND = $Bind; $env:LSA_BUS_PORT = "$Port"; $env:MOSQUITTO_VERSION = $Ver
  & docker compose -p lsa-conv-kit -f "$Kit\compose.yaml" up -d
  if ($LASTEXITCODE -ne 0) { Die 'docker compose up 失败' }
}
else {
  $exe = Find-Mosquitto
  if (-not $exe) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      Say 'winget 装 Eclipse Mosquitto'
      & winget install -e --id EclipseFoundation.Mosquitto --accept-package-agreements --accept-source-agreements
      $exe = Find-Mosquitto
    }
    if (-not $exe) { Die '没找到 mosquitto.exe：从 https://mosquitto.org/download/ 装 Windows 版（装到 C:\Program Files\mosquitto），再跑本脚本' }
  }
  Say "安装方式：本机 $exe，监听 ${Bind}:$Port"
  $old = Get-NativeProc
  if ($old) { Stop-Process -Id $old.Id -Force; Start-Sleep -Milliseconds 500 }
  if (Test-Listening) { Die "端口 $Port 已被别的程序占用（可能是装 Mosquitto 时注册的服务：Stop-Service mosquitto；或换端口 -Port 1885）" }
  New-Item -ItemType Directory -Force $DataDir | Out-Null
  $dataFwd = ($DataDir -replace '\\', '/') + '/'
  @"
# 转换程序测试总线（install.ps1 生成；-Uninstall 删掉）。与 EG 正式总线等价：不鉴权、持久化、放宽排队上限
listener $Port $Bind
allow_anonymous true
persistence true
persistence_location $dataFwd
max_queued_messages 50000
log_dest file $dataFwd/mosquitto.log
log_type error
log_type warning
log_type notice
"@ | Out-File -Encoding ascii $NativeConf
  $p = Start-Process -FilePath $exe -ArgumentList @('-c', "`"$NativeConf`"") -WindowStyle Hidden -PassThru
  Set-Content -Path $PidFile -Value $p.Id -Encoding ascii
  if ($Lan) { Warn "-Lan 时 Windows 防火墙可能挡住别的机器：管理员 PowerShell 里 New-NetFirewallRule -DisplayName 'LSA conv-kit MQTT' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow" }
}

# 自检
for ($i = 0; $i -lt 20 -and -not (Test-Listening); $i++) { Start-Sleep -Milliseconds 500 }
if (-not (Test-Listening)) { Die "端口 $Port 没起来：容器看 docker logs lsa-conv-mosquitto；本机方式看 $DataDir\mosquitto.log" }
$py = Get-Python
if (-not $py) { Warn '没有 Python 3.8+，跳过自检（检查工具 lsa_check.py 要它：https://www.python.org/downloads/ 或 winget install Python.Python.3.12）' }
else {
  Say '自检：发 6 s 示范数据并收一遍'
  $pyArgs = @()
  if ($py.Count -gt 1) { $pyArgs = $py[1..($py.Count - 1)] }
  $demo = Start-Process -FilePath $py[0] -ArgumentList ($pyArgs + @("`"$Kit\lsa_check.py`"", 'demo', '--cab', 'TEST', '--port', "$Port", '--duration', '6')) -WindowStyle Hidden -PassThru
  $log = Join-Path $env:TEMP 'lsa-conv-selftest.log'
  $env:PYTHONIOENCODING = 'utf-8'
  # PowerShell 5.1 会把原生程序的 stderr 当错误记录，Stop 下会中断：这里放宽
  $ErrorActionPreference = 'Continue'
  & $py[0] @pyArgs "$Kit\lsa_check.py" --port $Port --duration 8 --quiet *> $log
  $rc = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  $demo.WaitForExit(5000) | Out-Null
  if ($rc -ne 0) { Get-Content $log -Encoding utf8 -Tail 20; Die "自检没过（完整输出 $log）" }
  Say '自检通过：总线收发正常'
}
Write-Host ''
Say "装好了。转换程序连 mqtt://127.0.0.1:$Port（QoS 1、不 retain，格式见 EG内部MQTT格式.md）"
if ($Lan) { Write-Host "    局域网里别的机器连 mqtt://<本机 IP>:$Port；正式 EG 上只听 127.0.0.1" }
Write-Host "    检查：py -3 `"$Kit\lsa_check.py`" --cab <柜号> --group mv|tr|lv"
