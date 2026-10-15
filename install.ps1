# flowloop kurulum betiği (Windows, PowerShell)
#
#   powershell -ExecutionPolicy Bypass -File install.ps1           Eksikleri (Git, Node.js) kurar, sonra flowloop'u kurar
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Check    Hiçbir şey kurmadan ortamı kontrol eder
#   $env:FLOWLOOP_NODE="latest"     LTS yerine en güncel (Current) Node sürümünü kurar
#   $env:FLOWLOOP_SKIP_SETUP="1"    Kurulum sonunda hesap sorularını sorma (flowloop setup ile sonra yapılır)
#   $env:FLOWLOOP_SOURCE="<kaynak>" Başka bir kaynaktan kur: git adresi ya da .tgz
#
# Önerilen kurulum (tek komut, PowerShell'de):
#   git clone https://github.com/yunusemre/flowloop.git "$HOME\.flowloop\src"; powershell -ExecutionPolicy Bypass -File "$HOME\.flowloop\src\install.ps1"
# Güncelleme: flowloop update
#
# Git ve Node.js yoksa winget ile kurulur. Git for Windows (Git Bash) zorunludur: Claude Code ve
# flowloop'un kontrol komutları (testler, derleme) Windows'ta Git Bash ile çalışır.
# Tekrar çalıştırmak güvenlidir: kurulu olanı atlar, sadece eksikleri tamamlar.
param([switch]$Check)

# yerel komutların hataları $LASTEXITCODE ile tek tek kontrol edilir (PowerShell 5.1 stderr çıktısını hata sayabiliyor)
$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$MinNodeMajor = 20
$NodeChannel = if ($env:FLOWLOOP_NODE) { $env:FLOWLOOP_NODE } else { "lts" }
$DefaultSource = "git+https://github.com/yunusemre/flowloop.git"
$FlowHome = if ($env:FLOWLOOP_HOME) { $env:FLOWLOOP_HOME } else { Join-Path $HOME ".flowloop" }
$SrcDir = Join-Path $FlowHome "src"

function Ok($m)   { Write-Host "✓ $m" -ForegroundColor Green }
function Warn($m) { Write-Host "! $m" -ForegroundColor Yellow }
function Err($m)  { Write-Host "✗ $m" -ForegroundColor Red }
function Step($m) { Write-Host ""; Write-Host "── $m" }
function Fail($m) { Err $m; exit 1 }

# winget ile kurulan programlar yeni PATH'e yazılır; bu oturumda da görünsün
function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user"
}
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Node-Major {
  if (-not (Has "node")) { return 0 }
  try { return [int](& node -p "process.versions.node.split('.')[0]") } catch { return 0 }
}
function Winget-Install($id, $label) {
  if (-not (Has "winget")) { Fail "$label bulunamadı ve winget yok. Elle kur, sonra bu betiği tekrar çalıştır." }
  Write-Host "winget ile kuruluyor: $label ($id)"
  & winget install --id $id -e --source winget --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { Fail "$label kurulamadı (winget çıkış kodu $LASTEXITCODE)." }
  Refresh-Path
}
function Find-GitBash {
  foreach ($p in @($env:FLOWLOOP_BASH, $env:CLAUDE_CODE_GIT_BASH_PATH)) { if ($p -and (Test-Path $p)) { return $p } }
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($git) {
    $dir = Split-Path $git.Source
    for ($i = 0; $i -lt 3; $i++) {
      $c = Join-Path $dir "bin\bash.exe"
      if (Test-Path $c) { return $c }
      $dir = Split-Path $dir
    }
  }
  foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, (Join-Path $env:LOCALAPPDATA "Programs"))) {
    if ($base) { $c = Join-Path $base "Git\bin\bash.exe"; if (Test-Path $c) { return $c } }
  }
  return $null
}
function Run($exe, [string[]]$argv, $what) {
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { Fail "$what başarısız (çıkış kodu $LASTEXITCODE)." }
}

# Repo klasöründen mi çalışıyoruz?
$Dir = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "package.json"))) {
  if ((Get-Content (Join-Path $PSScriptRoot "package.json") -Raw) -match '"name":\s*"flowloop"') { $Dir = $PSScriptRoot }
}
$Source = $env:FLOWLOOP_SOURCE
if ($Source) { $Mode = "remote" } elseif ($Dir) { $Mode = "local" } else { $Mode = "remote"; $Source = $DefaultSource }

# ───────────── 1) Git ve Git Bash ─────────────
Step "Gereksinimler"
if (-not (Has "git")) {
  Warn "git bulunamadı"
  if ($Check) { Fail "Kurmak için: winget install Git.Git" }
  Winget-Install "Git.Git" "Git for Windows"
}
if (-not (Has "git")) { Fail "git kuruldu ama bu oturumda görünmüyor. Yeni bir PowerShell penceresi açıp tekrar çalıştır." }
Ok ("git " + ((& git --version) -replace '^git version ', ''))
$bash = Find-GitBash
if ($bash) { Ok "Git Bash: $bash" } else { Fail "Git Bash (bash.exe) bulunamadı. Git for Windows'u kur ya da yolunu FLOWLOOP_BASH ile ver." }

# ───────────── 2) Node.js ─────────────
if ((Node-Major) -ge $MinNodeMajor) {
  Ok "Node.js $(& node -v) (en az v$MinNodeMajor gerekli)"
} else {
  if (Has "node") { Warn "Node.js $(& node -v) eski (en az v$MinNodeMajor gerekli)" } else { Warn "Node.js bulunamadı" }
  if ($Check) { Fail "Kurmak için: powershell -ExecutionPolicy Bypass -File install.ps1" }
  if ($NodeChannel -eq "latest") { Winget-Install "OpenJS.NodeJS" "Node.js (Current)" } else { Winget-Install "OpenJS.NodeJS.LTS" "Node.js (LTS)" }
  if ((Node-Major) -lt $MinNodeMajor) { Fail "Node.js kuruldu ama bu oturumda görünmüyor. Yeni bir PowerShell penceresi açıp tekrar çalıştır." }
  Ok "Node.js $(& node -v) kuruldu"
}
# npm.ps1 yürütme ilkesine takılabilir; npm.cmd her zaman çalışır
$npm = "npm.cmd"
Ok "npm $(& $npm -v)"

if ($Check) {
  if (Has "flowloop") { & flowloop setup --check } else { Warn "flowloop henüz kurulu değil" }
  Write-Host ""; Ok "Kontrol bitti."; exit 0
}

# ───────────── 3) flowloop ─────────────
Step "flowloop kuruluyor"
# eski adlarla kurulmuş komutlar çakışmasın
foreach ($old in @("kgflow", "ekip")) {
  $groot = (& $npm root -g).Trim()
  if (Test-Path (Join-Path $groot $old)) { & $npm rm -g $old *> $null; Ok "Eski '$old' kurulumu kaldırıldı (artık: flowloop)" }
}

function Build-And-Link($where) {
  Push-Location $where
  try {
    if (Test-Path "package-lock.json") { Run $npm @("ci", "--no-audit", "--no-fund", "--loglevel=error") "npm ci" }
    else { Run $npm @("install", "--no-audit", "--no-fund", "--loglevel=error") "npm install" }
    Run $npm @("run", "build", "--silent") "Derleme"
    Ok "Derlendi"
    Run $npm @("link", "--loglevel=error") "npm link (flowloop komutunu sisteme ekleme)"
  } finally { Pop-Location }
}

$Commit = ""
if ($Mode -eq "local") {
  Build-And-Link $Dir
  $InstalledFrom = $Dir
  $Commit = (& git -C $Dir rev-parse HEAD 2>$null)
} elseif ($Source -match '\.(tgz|tar\.gz)$') {
  Write-Host "Kaynak: $Source"
  Run $npm @("install", "-g", "--no-audit", "--no-fund", "--loglevel=error", $Source) "npm install -g"
  $InstalledFrom = $Source
} else {
  $url = $Source -replace '^git\+', ''
  $ref = ""
  if ($url -match '#') { $ref = $url.Substring($url.IndexOf('#') + 1); $url = $url.Substring(0, $url.IndexOf('#')) }
  Write-Host "Kaynak: $url$(if ($ref) { " ($ref)" })"
  if (Test-Path (Join-Path $SrcDir ".git")) {
    Run git @("-C", $SrcDir, "remote", "set-url", "origin", $url) "git remote"
    $fetchRef = if ($ref) { $ref } else { "HEAD" }
    Run git @("-C", $SrcDir, "fetch", "--quiet", "--depth", "1", "origin", $fetchRef) "Kaynağa erişim ($url)"
    Run git @("-C", $SrcDir, "reset", "--quiet", "--hard", "FETCH_HEAD") "git reset"
  } else {
    New-Item -ItemType Directory -Force -Path (Split-Path $SrcDir) | Out-Null
    $cloneArgs = @("clone", "--quiet", "--depth", "1")
    if ($ref) { $cloneArgs += @("--branch", $ref) }
    Run git ($cloneArgs + @($url, $SrcDir)) "Kaynağa erişim ($url)"
  }
  Build-And-Link $SrcDir
  $InstalledFrom = $Source
  $Commit = (& git -C $SrcDir rev-parse HEAD)
  $Mode = "managed"
}

# flowloop update bu kaydı kullanır
New-Item -ItemType Directory -Force -Path $FlowHome | Out-Null
$groot = (& $npm root -g).Trim()
$Version = "?"
try { $Version = (Get-Content (Join-Path $groot "flowloop\package.json") -Raw | ConvertFrom-Json).version } catch { }
$info = [ordered]@{ mode = $Mode; source = $InstalledFrom; dir = $SrcDir; commit = "$Commit"; version = $Version; installedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
# BOM'suz UTF-8 (Node JSON.parse BOM'u kabul etmez)
[IO.File]::WriteAllText((Join-Path $FlowHome "install.json"), ($info | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
Ok "flowloop $Version kuruldu ($Mode)"

Refresh-Path
$prefix = (& $npm prefix -g).Trim()
# npm her komut için bir de .ps1 kısayolu yazar; PowerShell onu .cmd'den önce seçer. Betik çalıştırma
# kapalıysa (Restricted/AllSigned, Windows'un varsayılanı) "running scripts is disabled" hatası alınır.
# O durumda .ps1 kısayolu kaldırılır, PowerShell .cmd kısayolunu kullanır; ilkeye dokunulmaz.
$policy = "$(Get-ExecutionPolicy)"
if ($policy -in @("Restricted", "AllSigned", "Undefined")) {
  foreach ($n in @("flowloop", "kgflow")) {
    $ps1 = Join-Path $prefix "$n.ps1"
    if ((Test-Path $ps1) -and (Test-Path (Join-Path $prefix "$n.cmd"))) { Remove-Item $ps1 -Force }
  }
  Ok "PowerShell betik çalıştırmayı kapalı tutuyor ($policy); flowloop .cmd kısayoluyla çalışacak"
}
if (Has "flowloop") { Ok "flowloop komutu hazır: $((Get-Command flowloop).Source)" }
elseif (Test-Path (Join-Path $prefix "flowloop.cmd")) {
  Warn "flowloop kuruldu ($prefix\flowloop.cmd) ama bu klasör PATH'te değil."
  Write-Host "   Kalıcı çözüm (bir kez çalıştır, sonra yeni pencere aç):"
  Write-Host "   [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';$prefix', 'User')"
} else { Fail "flowloop komutu oluşmadı ($prefix\flowloop.cmd yok)." }

if ($env:FLOWLOOP_UPDATING) { exit 0 }

# ───────────── 4) Hesap bilgileri ─────────────
$flow = Join-Path $prefix "flowloop.cmd"
if (-not $env:FLOWLOOP_SKIP_SETUP -and (Test-Path $flow) -and [Environment]::UserInteractive) {
  Write-Host ""
  & $flow setup
  if ($LASTEXITCODE -ne 0) { Warn "Hesap kurulumu tamamlanmadı; istediğin zaman: flowloop setup" }
} else {
  Write-Host ""; Write-Host "Hesap bilgilerini (Claude/Cursor, Jira, Bitbucket) kurmak için: flowloop setup"
}
Write-Host ""
Write-Host "Güncellemek için: flowloop update"
Write-Host ""
Write-Host "Sıradaki adım (projende):"
Write-Host "  cd <proje>; flowloop init; flowloop check"
Write-Host "  flowloop run PROJ-1234 --approve-plan -v"
