#!/usr/bin/env bash
# kgflow kurulum betiği (macOS / Linux)
#
#   ./install.sh                 Node yoksa ya da eskiyse en güncel LTS sürümünü kurar, sonra kgflow'u kurar
#   KGFLOW_NODE=latest ./install.sh   LTS yerine en güncel (Current) Node sürümünü kurar
#   KGFLOW_FORCE_NVM=1 ./install.sh   Node kurulu olsa bile nvm ile (sudo'suz) kurar
#   ./install.sh --check         Hiçbir şey kurmadan sadece ortamı kontrol eder
#   KGFLOW_SKIP_SETUP=1 ...      Kurulum sonunda hesap sorularını sorma (kgflow setup ile sonra yapılır)
#
# Önerilen kurulum (tek komut):
#   git clone https://github.com/yunusemre/flowloop.git ~/.kgflow/src && ~/.kgflow/src/install.sh
# Başka bir kaynaktan:
#   KGFLOW_SOURCE=<kaynak> bash install.sh    kaynak: git+ssh://...git, .tgz yolu ya da adresi
# Git kaynağı ~/.kgflow/src klasörüne (gizli, sana ait) çekilip oradan kurulur; .tgz ise npm ile kurulur.
# Güncelleme: kgflow update
#
# Tekrar çalıştırmak güvenlidir: kurulu olanı atlar, sadece eksikleri tamamlar.
set -euo pipefail

MIN_NODE_MAJOR=20
NODE_CHANNEL="${KGFLOW_NODE:-lts}"   # lts | latest
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

# kgflow reposu. Farklıysa KGFLOW_SOURCE ile değiştir.
DEFAULT_SOURCE="git+https://github.com/yunusemre/flowloop.git"

# Repo klasöründen mi çalışıyoruz, yoksa curl | bash ile mi geldik?
DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  grep -q '"name": "kgflow"' "$DIR/package.json" 2>/dev/null || DIR=""
fi
SOURCE="${KGFLOW_SOURCE:-}"
if [[ -n "$SOURCE" ]]; then MODE=remote; elif [[ -n "$DIR" ]]; then MODE=local; else MODE=remote; SOURCE="$DEFAULT_SOURCE"; fi
SRC_DIR="${KGFLOW_HOME:-$HOME/.kgflow}/src"
[[ "$MODE" == local ]] && cd "$DIR"

if [[ -t 1 ]]; then G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else G='' Y='' R='' N=''; fi
ok()   { echo "${G}✓${N} $*"; }
warn() { echo "${Y}!${N} $*"; }
err()  { echo "${R}✗${N} $*" >&2; }
step() { echo; echo "── $*"; }

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh"
  command -v nvm >/dev/null 2>&1
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
  if [[ "$NODE_CHANNEL" == "latest" && -z "${KGFLOW_FORCE_NVM:-}" ]] && ! load_nvm && command -v brew >/dev/null 2>&1; then
    brew install node || brew upgrade node   # Homebrew'un "node" paketi Current sürümüdür
  else
    load_nvm || install_nvm                  # LTS için (ve sudo'suz kurulum için) nvm
    if [[ "$NODE_CHANNEL" == "latest" ]]; then nvm install node && nvm alias default node; else nvm install --lts && nvm alias default 'lts/*'; fi \
      || { err "Node.js indirilemedi (nodejs.org erişimini kontrol et)."; exit 1; }
  fi
  hash -r
}

# ───────────── 1) git ─────────────
step "Gereksinimler"
if command -v git >/dev/null 2>&1; then ok "git $(git --version | awk '{print $3}')"; else
  err "git bulunamadı. macOS: xcode-select --install · Linux: sudo apt install git"; exit 1; fi

# ───────────── 2) Node.js ─────────────
load_nvm >/dev/null 2>&1 || true
if [[ -z "${KGFLOW_FORCE_NVM:-}" ]] && command -v node >/dev/null 2>&1 && (( $(node_major) >= MIN_NODE_MAJOR )); then
  ok "Node.js $(node -v) (en az v${MIN_NODE_MAJOR} gerekli)"
else
  if [[ -n "${KGFLOW_FORCE_NVM:-}" ]]; then warn "KGFLOW_FORCE_NVM: Node.js nvm ile kurulacak"
  elif command -v node >/dev/null 2>&1; then warn "Node.js $(node -v) eski (en az v${MIN_NODE_MAJOR} gerekli)"; else warn "Node.js bulunamadı"; fi
  if (( CHECK_ONLY )); then err "Kurmak için: ./install.sh"; exit 1; fi
  install_node
  (( $(node_major) >= MIN_NODE_MAJOR )) || { err "Node.js kurulamadı. Elle kur: https://nodejs.org"; exit 1; }
  ok "Node.js $(node -v) kuruldu"
fi
ok "npm $(npm -v)"

# ───────────── 3) Hesaplar ─────────────
# Ayrıntılı kontrol ve kurulum kgflow setup'ta (gizli bilgiler orada güvenli yerde saklanır)
if (( CHECK_ONLY )); then
  if command -v kgflow >/dev/null 2>&1; then kgflow setup --check || true; else warn "kgflow henüz kurulu değil"; fi
  echo; ok "Kontrol bitti."; exit 0
fi

# ───────────── 4) kgflow ─────────────
step "kgflow kuruluyor"
link_fail() {
  err "Global npm klasörüne yazılamadı (yetki)."
  echo "   Çözüm: Node'u nvm ile kur (sudo gerekmez):  KGFLOW_FORCE_NVM=1 bash install.sh"
  exit 1
}
if [[ "$MODE" == local ]]; then
  if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund --loglevel=error; else npm install --no-audit --no-fund --loglevel=error; fi
  npm run build --silent
  ok "Derlendi"
  npm link --loglevel=error >/dev/null 2>&1 || link_fail
  INSTALLED_FROM="$DIR"
  COMMIT="$(git -C "$DIR" rev-parse HEAD 2>/dev/null || true)"
elif [[ "$SOURCE" == *.tgz || "$SOURCE" == *.tar.gz ]]; then
  # hazır derlenmiş paket: derleme gerekmez
  echo "Kaynak: $SOURCE"
  npm install -g --no-audit --no-fund --loglevel=error "$SOURCE" || link_fail
  INSTALLED_FROM="$SOURCE"
  COMMIT=""
else
  # git kaynağı: ~/.kgflow/src'ye çek (sığ kopya), oradan kur
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
    npm link --loglevel=error >/dev/null 2>&1
  ) || link_fail
  ok "Derlendi"
  INSTALLED_FROM="$SOURCE"
  COMMIT="$(git -C "$SRC_DIR" rev-parse HEAD)"
  MODE=managed
fi
# kgflow update bu kaydı kullanır
mkdir -p "$HOME/.kgflow"
VERSION="$(node -p "require('$(npm root -g)/kgflow/package.json').version" 2>/dev/null || echo "?")"
cat > "$HOME/.kgflow/install.json" <<JSON
{ "mode": "$MODE", "source": "$INSTALLED_FROM", "dir": "${SRC_DIR}", "commit": "$COMMIT", "version": "$VERSION", "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
JSON
ok "kgflow $VERSION kuruldu ($MODE)"

hash -r
if command -v kgflow >/dev/null 2>&1; then ok "kgflow komutu hazır: $(command -v kgflow)"; else
  warn "kgflow kuruldu ama PATH'te görünmüyor. Yeni bir terminal aç ya da: export PATH=\"$(npm prefix -g)/bin:\$PATH\""; fi

[[ -n "${KGFLOW_UPDATING:-}" ]] && exit 0

# ───────────── 5) Hesap bilgileri ─────────────
KGFLOW_BIN="$(npm prefix -g)/bin/kgflow"
[[ -x "$KGFLOW_BIN" ]] || KGFLOW_BIN="$(command -v kgflow || true)"
if [[ -n "$KGFLOW_BIN" && -z "${KGFLOW_SKIP_SETUP:-}" ]] && { : </dev/tty; } 2>/dev/null; then
  echo
  # curl | bash ile gelindiğinde stdin borudur; sorular terminalden okunur
  "$KGFLOW_BIN" setup </dev/tty || warn "Hesap kurulumu tamamlanmadı; istediğin zaman: kgflow setup"
else
  echo
  echo "Hesap bilgilerini (Claude/Cursor, Jira, Bitbucket) kurmak için: kgflow setup"
fi
echo
echo "Güncellemek için: kgflow update"
echo
echo "Sıradaki adım (projende):"
echo "  cd <proje> && kgflow init && kgflow check"
echo "  kgflow run IDT-1234 --plan-onayi -v"
