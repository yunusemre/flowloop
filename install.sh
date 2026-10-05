#!/usr/bin/env bash
# kgflow kurulum betiği (macOS / Linux)
#
#   ./install.sh                 Node yoksa ya da eskiyse en güncel LTS sürümünü kurar, sonra kgflow'u kurar
#   KGFLOW_NODE=latest ./install.sh   LTS yerine en güncel (Current) Node sürümünü kurar
#   KGFLOW_FORCE_NVM=1 ./install.sh   Node kurulu olsa bile nvm ile (sudo'suz) kurar
#   ./install.sh --check         Hiçbir şey kurmadan sadece ortamı kontrol eder
#
# Tekrar çalıştırmak güvenlidir: kurulu olanı atlar, sadece eksikleri tamamlar.
set -euo pipefail

MIN_NODE_MAJOR=20
NODE_CHANNEL="${KGFLOW_NODE:-lts}"   # lts | latest
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

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

# ───────────── 3) Claude ve Jira erişimi (sadece kontrol) ─────────────
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then ok "Claude: ANTHROPIC_API_KEY tanımlı"
elif [[ -d "$HOME/.claude" ]] || command -v claude >/dev/null 2>&1; then ok "Claude: Claude Code girişi kullanılacak"
else warn "Claude kimliği bulunamadı: Claude Code'a giriş yap (claude → /login) ya da ANTHROPIC_API_KEY tanımla"; fi

if [[ -n "${JIRA_EMAIL:-}" && -n "${JIRA_API_TOKEN:-}" ]]; then ok "Jira: JIRA_EMAIL ve JIRA_API_TOKEN tanımlı"
else warn "Jira: JIRA_EMAIL / JIRA_API_TOKEN tanımlı değil (kgflow run IDT-xxxx için gerekli; KULLANIM.md → Jira)"; fi

(( CHECK_ONLY )) && { echo; ok "Kontrol bitti."; exit 0; }

# ───────────── 4) kgflow ─────────────
step "kgflow kuruluyor"
if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund --loglevel=error; else npm install --no-audit --no-fund --loglevel=error; fi
npm run build --silent
ok "Derlendi"

if ! npm link --loglevel=error 2>/dev/null; then
  err "npm link yetki hatası verdi (global npm klasörü yazılabilir değil)."
  echo "   Çözüm: Node'u nvm ile kur (sudo gerekmez):  KGFLOW_FORCE_NVM=1 ./install.sh"
  echo "   ya da tek seferlik:                          sudo npm link"
  exit 1
fi
hash -r
if command -v kgflow >/dev/null 2>&1; then ok "kgflow komutu hazır: $(command -v kgflow)"; else
  warn "kgflow kuruldu ama PATH'te görünmüyor. Yeni bir terminal aç ya da: export PATH=\"$(npm prefix -g)/bin:\$PATH\""; fi

echo
echo "Sıradaki adım (projende):"
echo "  cd <proje> && kgflow init && kgflow check"
echo "  kgflow run IDT-1234 --plan-onayi -v"
