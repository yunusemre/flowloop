#!/usr/bin/env bash
# flowloop kurulum betiği (macOS / Linux)
#
#   ./install.sh                 Node yoksa ya da eskiyse en güncel LTS sürümünü kurar, sonra flowloop'u kurar
#   FLOWLOOP_NODE=latest ./install.sh   LTS yerine en güncel (Current) Node sürümünü kurar
#   FLOWLOOP_FORCE_NVM=1 ./install.sh   Node kurulu olsa bile nvm ile (sudo'suz) kurar
#   ./install.sh --check         Hiçbir şey kurmadan sadece ortamı kontrol eder
#   FLOWLOOP_SKIP_SETUP=1 ...      Kurulum sonunda hesap sorularını sorma (flowloop setup ile sonra yapılır)
#
# Önerilen kurulum (tek komut):
#   git clone https://github.com/yunusemre/flowloop.git ~/.flowloop/src && ~/.flowloop/src/install.sh
# Başka bir kaynaktan:
#   FLOWLOOP_SOURCE=<kaynak> bash install.sh    kaynak: git+ssh://...git, .tgz yolu ya da adresi
# Git kaynağı ~/.flowloop/src klasörüne (gizli, sana ait) çekilip oradan kurulur; .tgz ise npm ile kurulur.
# Güncelleme: flowloop update
#
# Tekrar çalıştırmak güvenlidir: kurulu olanı atlar, sadece eksikleri tamamlar.
set -euo pipefail
# beklenmedik bir hata sessizce bitirmesin
trap 'echo "✗ Kurulum beklenmedik şekilde durdu (satır $LINENO). Ayrıntı için: bash -x install.sh" >&2' ERR

MIN_NODE_MAJOR=20
NODE_CHANNEL="${FLOWLOOP_NODE:-lts}"   # lts | latest
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

# flowloop reposu. Farklıysa FLOWLOOP_SOURCE ile değiştir.
DEFAULT_SOURCE="git+https://github.com/yunusemre/flowloop.git"

# Repo klasöründen mi çalışıyoruz, yoksa curl | bash ile mi geldik?
DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  grep -q '"name": "flowloop"' "$DIR/package.json" 2>/dev/null || DIR=""
fi
SOURCE="${FLOWLOOP_SOURCE:-}"
if [[ -n "$SOURCE" ]]; then MODE=remote; elif [[ -n "$DIR" ]]; then MODE=local; else MODE=remote; SOURCE="$DEFAULT_SOURCE"; fi
SRC_DIR="${FLOWLOOP_HOME:-$HOME/.flowloop}/src"
[[ "$MODE" == local ]] && cd "$DIR"

if [[ -t 1 ]]; then G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else G='' Y='' R='' N=''; fi
ok()   { echo "${G}✓${N} $*"; }
warn() { echo "${Y}!${N} $*"; }
err()  { echo "${R}✗${N} $*" >&2; }
step() { echo; echo "── $*"; }

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# nvm betikleri "set -eu" ile uyumlu değil (tanımsız değişken kullanır); yüklerken ve
# çalıştırırken bu ayarlar kapatılır, yoksa kurulum sessizce yarıda kalır.
load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  [[ -s "$NVM_DIR/nvm.sh" ]] || return 1
  set +eu
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  set -eu
  command -v nvm >/dev/null 2>&1
}
nvm_run() {
  set +eu
  nvm "$@"
  local rc=$?
  set -eu
  return "$rc"
}

install_nvm() {
  step "nvm kuruluyor (Node sürüm yöneticisi, sudo gerektirmez)"
  local tag
  # en güncel sürüm etiketi (GitHub API limitine takılmamak için yönlendirmeden okunur)
  tag="$(curl -fsSI -o /dev/null -w '%{redirect_url}' https://github.com/nvm-sh/nvm/releases/latest 2>/dev/null | sed 's#.*/tag/##' || true)"
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || tag="v0.40.8"
  curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${tag}/install.sh" | METHOD=script bash >/dev/null \
    || { err "nvm indirilemedi (internet/proxy erişimini kontrol et) — Node'u elle kurabilirsin: https://nodejs.org"; exit 1; }
  load_nvm || { err "nvm kurulamadı."; exit 1; }
  ok "nvm ${tag} kuruldu"
  ok "nvm kabuk ayar dosyana (~/.zshrc ya da ~/.bashrc) eklendi; yeni terminallerde otomatik yüklenir"
}

install_node() {
  local label; [[ "$NODE_CHANNEL" == "latest" ]] && label="en güncel (Current)" || label="en güncel LTS"
  step "Node.js kuruluyor: ${label}"
  if [[ "$NODE_CHANNEL" == "latest" && -z "${FLOWLOOP_FORCE_NVM:-}" ]] && ! load_nvm && command -v brew >/dev/null 2>&1; then
    brew install node || brew upgrade node   # Homebrew'un "node" paketi Current sürümüdür
  else
    load_nvm || install_nvm                  # LTS için (ve sudo'suz kurulum için) nvm
    if [[ "$NODE_CHANNEL" == "latest" ]]; then nvm_run install node && nvm_run alias default node; else nvm_run install --lts && nvm_run alias default 'lts/*'; fi \
      || { err "Node.js indirilemedi (nodejs.org erişimini kontrol et)."; exit 1; }
  fi
  hash -r
}

# ───────────── 1) git ─────────────
step "Gereksinimler"
if command -v git >/dev/null 2>&1; then ok "git $(git --version | awk '{print $3}')"; else
  err "git bulunamadı. macOS: xcode-select --install · Linux: sudo apt install git"; exit 1; fi

# ───────────── 2) Node.js ─────────────
# Node PATH'te yoksa, nvm ile kurulmuş olabilir: önce onu yüklemeyi dene
command -v node >/dev/null 2>&1 || load_nvm || true
if [[ -z "${FLOWLOOP_FORCE_NVM:-}" ]] && command -v node >/dev/null 2>&1 && (( $(node_major) >= MIN_NODE_MAJOR )); then
  ok "Node.js $(node -v) (en az v${MIN_NODE_MAJOR} gerekli)"
else
  if [[ -n "${FLOWLOOP_FORCE_NVM:-}" ]]; then warn "FLOWLOOP_FORCE_NVM: Node.js nvm ile kurulacak"
  elif command -v node >/dev/null 2>&1; then warn "Node.js $(node -v) eski (en az v${MIN_NODE_MAJOR} gerekli)"; else warn "Node.js bulunamadı"; fi
  if (( CHECK_ONLY )); then err "Kurmak için: ./install.sh"; exit 1; fi
  install_node
  (( $(node_major) >= MIN_NODE_MAJOR )) || { err "Node.js kurulamadı. Elle kur: https://nodejs.org"; exit 1; }
  ok "Node.js $(node -v) kuruldu"
fi
ok "npm $(npm -v)"

# ───────────── 3) Hesaplar ─────────────
# Ayrıntılı kontrol ve kurulum flowloop setup'ta (gizli bilgiler orada güvenli yerde saklanır)
if (( CHECK_ONLY )); then
  if command -v flowloop >/dev/null 2>&1; then flowloop setup --check || true; else warn "flowloop henüz kurulu değil"; fi
  echo; ok "Kontrol bitti."; exit 0
fi

# ───────────── 4) flowloop ─────────────
step "flowloop kuruluyor"
LINK_LOG="$(mktemp)"
link_fail() {
  err "flowloop komutu sisteme eklenemedi."
  if grep -qi "EACCES\|permission denied" "$LINK_LOG" 2>/dev/null; then
    echo "   Sebep: global npm klasörüne yazma yetkisi yok ($(npm prefix -g))."
    echo "   Çözüm: Node'u nvm ile kur (sudo gerekmez):  FLOWLOOP_FORCE_NVM=1 bash install.sh"
  elif grep -qi "EEXIST" "$LINK_LOG" 2>/dev/null; then
    echo "   Sebep: aynı adlı eski bir komut var. Kaldırıp tekrar dene:"
    grep -o "File exists: [^ ]*" "$LINK_LOG" | head -1 | sed 's/^/   /'
    echo "   O dosyayı silip tekrar dene:  rm \"<yukarıdaki yol>\" && bash install.sh"
  fi
  [[ -s "$LINK_LOG" ]] && { echo "   npm çıktısı:"; tail -8 "$LINK_LOG" | sed 's/^/     /'; }
  exit 1
}
# Eski adlarla (kgflow, ekip) kurulmuş komutlar yeni bağlantıyla çakışır; önce kaldır.
# Klasörü taşınmış eski bir "npm link" kırık kalır ve "npm rm -g" onu silemez; o yüzden
# sadece bize ait sembolik bağlantılar doğrudan silinir.
remove_legacy() {
  local groot gbin old removed
  groot="$(npm root -g)"; gbin="$(npm prefix -g)/bin"
  for old in kgflow ekip; do
    removed=0
    if [[ -L "$groot/$old" ]]; then rm -f "$groot/$old"; removed=1
    elif [[ -d "$groot/$old" ]]; then npm rm -g "$old" >/dev/null 2>&1 && removed=1; fi
    if [[ -L "$gbin/$old" ]] && readlink "$gbin/$old" | grep -Eq "node_modules/(kgflow|ekip)/"; then rm -f "$gbin/$old"; removed=1; fi
    (( removed )) && ok "Eski '$old' kurulumu kaldırıldı (artık: flowloop)"
  done
  return 0
}
remove_legacy
if [[ "$MODE" == local ]]; then
  if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund --loglevel=error; else npm install --no-audit --no-fund --loglevel=error; fi
  npm run build --silent
  ok "Derlendi"
  npm link --loglevel=error >"$LINK_LOG" 2>&1 || link_fail
  INSTALLED_FROM="$DIR"
  COMMIT="$(git -C "$DIR" rev-parse HEAD 2>/dev/null || true)"
elif [[ "$SOURCE" == *.tgz || "$SOURCE" == *.tar.gz ]]; then
  # hazır derlenmiş paket: derleme gerekmez
  echo "Kaynak: $SOURCE"
  npm install -g --no-audit --no-fund --loglevel=error "$SOURCE" >"$LINK_LOG" 2>&1 || link_fail
  INSTALLED_FROM="$SOURCE"
  COMMIT=""
else
  # git kaynağı: ~/.flowloop/src'ye çek (sığ kopya), oradan kur
  url="${SOURCE#git+}"; ref=""
  [[ "$url" == *#* ]] && { ref="${url##*#}"; url="${url%%#*}"; }
  echo "Kaynak: $url${ref:+ ($ref)}"
  if [[ -d "$SRC_DIR/.git" ]]; then
    git -C "$SRC_DIR" remote set-url origin "$url"
    git -C "$SRC_DIR" fetch --quiet --depth 1 origin "${ref:-HEAD}" || { err "Kaynağa erişilemedi: $url"; [[ "$url" == *bitbucket* ]] && echo "   SSH erişimini dene: ssh -T git@bitbucket.org"; exit 1; }
    git -C "$SRC_DIR" reset --quiet --hard FETCH_HEAD
  else
    mkdir -p "$(dirname "$SRC_DIR")"
    git clone --quiet --depth 1 ${ref:+--branch "$ref"} "$url" "$SRC_DIR" || { err "Kaynağa erişilemedi: $url"; [[ "$url" == *bitbucket* ]] && echo "   SSH erişimini dene: ssh -T git@bitbucket.org"; exit 1; }
  fi
  (
    cd "$SRC_DIR"
    if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund --loglevel=error; else npm install --no-audit --no-fund --loglevel=error; fi
    npm run build --silent
    npm link --loglevel=error >"$LINK_LOG" 2>&1
  ) || link_fail
  ok "Derlendi"
  INSTALLED_FROM="$SOURCE"
  COMMIT="$(git -C "$SRC_DIR" rev-parse HEAD)"
  MODE=managed
fi
# flowloop update bu kaydı kullanır
mkdir -p "$HOME/.flowloop"
VERSION="$(node -p "require('$(npm root -g)/flowloop/package.json').version" 2>/dev/null || echo "?")"
cat > "$HOME/.flowloop/install.json" <<JSON
{ "mode": "$MODE", "source": "$INSTALLED_FROM", "dir": "${SRC_DIR}", "commit": "$COMMIT", "version": "$VERSION", "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
JSON
ok "flowloop $VERSION kuruldu ($MODE)"

hash -r
GLOBAL_BIN="$(npm prefix -g)/bin"
if command -v flowloop >/dev/null 2>&1; then ok "flowloop komutu hazır: $(command -v flowloop)"
elif [[ -x "$GLOBAL_BIN/flowloop" ]]; then
  warn "flowloop kuruldu ($GLOBAL_BIN/flowloop) ama bu klasör PATH'te değil."
  echo "   Kalıcı çözüm — şu satırı ~/.zshrc dosyasına ekle ve yeni terminal aç:"
  echo "   export PATH=\"$GLOBAL_BIN:\$PATH\""
else
  err "flowloop komutu oluşmadı ($GLOBAL_BIN/flowloop yok)."; [[ -s "$LINK_LOG" ]] && tail -8 "$LINK_LOG"; exit 1
fi

[[ -n "${FLOWLOOP_UPDATING:-}" ]] && exit 0

# ───────────── 5) Hesap bilgileri ─────────────
FLOWLOOP_BIN="$(npm prefix -g)/bin/flowloop"
[[ -x "$FLOWLOOP_BIN" ]] || FLOWLOOP_BIN="$(command -v flowloop || true)"
if [[ -n "$FLOWLOOP_BIN" && -z "${FLOWLOOP_SKIP_SETUP:-}" ]] && { : </dev/tty; } 2>/dev/null; then
  echo
  # curl | bash ile gelindiğinde stdin borudur; sorular terminalden okunur
  "$FLOWLOOP_BIN" setup </dev/tty || warn "Hesap kurulumu tamamlanmadı; istediğin zaman: flowloop setup"
else
  echo
  echo "Hesap bilgilerini (Claude/Cursor, Jira, Bitbucket) kurmak için: flowloop setup"
fi
echo
echo "Güncellemek için: flowloop update"
echo
echo "Sıradaki adım (projende):"
echo "  cd <proje> && flowloop init && flowloop check"
echo "  flowloop run PROJ-1234 --approve-plan -v"
