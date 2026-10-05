# kgflow

Rol bazlı AI geliştirme ekibi. Bir Jira görevini alır, dört rolden geçirir ve sonucu push'lanmış bir branch, PR bağlantısı ve Jira yorumu olarak teslim eder. Merge her zaman insandadır.

```
Jira görevi ─► ANALİST ─► plan ─(senin onayın)─► DEVELOPER ─► otomatik kontroller ─► REVIEWER ─(PASS)─► SENİN ONAYIN ─► COMMITTER ─► push + Jira yorumu
                  ▲            │                    ▲          (format, bu işin testleri,           │              │
                  └── yorumun ─┘                    └── FAIL ── yeni tip/lint hataları) ◄────────────┘              │
                                                    └──────────────────── değişiklik isteğin ◄─────────────────────┘
```

Sen onaylamadan hiçbir şey commit'lenmez, push'lanmaz ve Jira'ya yazılmaz.

Ayrıntılı kılavuz: **[KULLANIM.md](KULLANIM.md)**

## Hızlı başlangıç

```bash
# 1) Kur: repoyu ~/.kgflow/src'ye indirir, Node yoksa kurar, kgflow komutunu ekler ve hesap kurulumunu başlatır
git clone https://github.com/yunusemre/flowloop.git ~/.kgflow/src && ~/.kgflow/src/install.sh

# 2) Projeye ekle (proje başına bir kez)
cd ~/Desktop/WORK/KG/kgs-app
kgflow init && kgflow check

# 3) Jira görevini çalıştır (--plan-onayi: planı onayla, yorumla güncellet ya da iptal et)
kgflow run IDT-1234 --plan-onayi -v
```

| Komut | Ne yapar |
|---|---|
| `kgflow setup` | Hesapları adım adım kurar: git kimliği, Claude/Cursor, Jira, Bitbucket. Kurulum sonunda kendiliğinden açılır |
| `kgflow update` | kgflow'u günceller. Yeni sürüm çıkınca kgflow ekranın başında haber verir |
| `kgflow runs` / `kgflow resume <id>` | Çalıştırmaları listeler / yarım kalanı sürdürür |
| `kgflow --version` | Sürümü ve kurulum kaynağını gösterir |

Gereksinimler: macOS ya da Linux ve git. Node.js 20+ yoksa kurulum betiği kurar. Push için projenin kendi reposuna (ör. Bitbucket) erişimin olmalı.

## Roller

| Rol | Yapabilir | Yapamaz |
|---|---|---|
| Analist | Kodu ve proje kurallarını okur, kabul kriterli plan yazar | Kod değiştirmek, komut çalıştırmak |
| Developer | `paths.edit` altını düzenler; bu işin testlerini ve lint'i çalıştırır | Başka dosya, tüm test suite'i, commit |
| Reviewer | Okur, testleri çalıştırır, kodu **kopyada** bozarak testleri dener (mutasyon testi), PASS/FAIL verir | Gerçek dosyaya yazmak, commit |
| Committer | `git add`, `git commit`, Jira özeti | Dosya düzenlemek, push, `--no-verify`, `--amend` |

Ajanlar [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) ile çalışır; Claude erişimi yoksa otomatik olarak Cursor CLI kullanılır (`agent: auto | claude | cursor`). İki durumda da yetkiler aynı kodla zorlanır.

## İlkeler

1. **Projenin kendi kuralları geçerlidir.** `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.cursor/rules/*.mdc` ve `.github/copilot-instructions.md` varsa bütün rollere verilir; kişisel `~/.claude/CLAUDE.md` de eklenir (çelişirse proje kuralı geçerli).
2. **Sadece bu işe odaklanılır.** Projede zaten var olan tip hataları, lint hataları ve kırık testler kimseyi bloklamaz. kgflow aynı kontrolleri dokunulmamış bir base kopyasında da çalıştırır ve sadece bu işle **gelen** hataları sayar. Lint uyarıları bloklamaz.
3. **Testler işe özeldir.** Tüm suite değil, değişen dosyalarla ilgili testler çalışır (Jest'te `--findRelatedTests`).
4. **Her zaman temiz bir çalışma alanı kullanılır.** İş, `origin`'den çekilen base branch (`production → main → master`) üzerinde açılan ayrı bir worktree'de yapılır; senin çalışma klasörüne dokunulmaz.
5. **Teknolojiye göre çalışılır.** `kgflow init` projeyi tanır (React Native/Expo, React, Next.js, Node, NestJS, .NET) ve test, tip kontrolü, lint ve format komutlarını projenin kendi araçlarına göre seçer.

## Güvenlik modeli

- **Kodla yazılmış yetki politikası** (`src/policy.ts`): her araç çağrısı (okumalar dahil) bu politikadan geçer. Claude'da `PreToolUse` hook'u, Cursor'da geçici `.cursor/hooks.json` kullanılır; hook çalışmazsa işlem reddedilir.
  - Yollar gerçek konumlarına çözülür; symlink ya da `..` ile çalışma alanının dışına çıkılamaz.
  - Bash komutları tek ve basit olmak zorundadır (`&&`, `|`, `;`, `>`, `$()` yasak) ve rolün izinli komut önekiyle başlamalıdır.
  - `readDeny` listesindeki dosyalar (`.env` gibi) hiçbir rol tarafından okunamaz.
- **Gizli bilgiler ajana geçmez.** Token'lar macOS Anahtar Zinciri'nde (Linux'ta sistem anahtarlığında) saklanır. Ajanlar ve onların çalıştırdığı testler `*_TOKEN`, `*_SECRET`, `JIRA_*` gibi değişkenleri görmez.
- **Git kontrolleri** (`src/orchestrator.ts`), her aşamadan sonra:
  - Analist ve reviewer gerçek dosyalara dokunmamış olmalı; developer commit atmamış ve izinli yolların dışına yazmamış olmalı.
  - Commit'lenen içerik, reviewer'ın onayladığı içeriğin tree hash'iyle birebir aynı olmalı. Commit hook'ları dosya değiştirirse bu kontrol yakalar.
  - Commit mesajları Conventional Commits formatında olmalı ya da `commitlint`'ten geçmeli.
- **Merge her zaman insandadır.** Force push asla yapılmaz; branch push'lanır ve PR bağlantısı verilir.

## Jira

`kgflow run IDT-1234` görevi Jira'dan çeker. İş bitince kayda kısa bir yorum eklenir: sorun / yapılan / neden bu yaklaşım / nasıl test edildi (committer yazar), branch, commit'ler, PR bağlantısı, kullanılan modeller ve "insan incelemesi gerekir" notu. Commit'lerdeki `Co-Authored-By` satırı işi kimin yaptığını gösterir.

## Yapılandırma (`.kgflow/kgflow.yaml`)

| Alan | Açıklama |
|---|---|
| `baseBranch` | Boş bırakılırsa production → main → master sırasıyla seçilir |
| `branchName` | `{{jira}}-{{slug}}` ya da `kgflow/{{slug}}-{{date}}` |
| `push` | İş bitince branch'i origin'e gönder (`--no-push` ile tek seferlik kapatılır) |
| `jira.baseUrl` / `jira.comment` | Projeye özel Jira adresi (boşsa `kgflow setup`'ta girilen) / iş bitince kayda özet yorumu |
| `commands.testRelated` | Bu işin testleri; `{{files}}` ya da `{{testFiles}}` içermek zorunda |
| `commands.typecheck` | Tüm projenin tip kontrolü; sadece yeni hatalar sayılır |
| `commands.lint` | `{{files}}` ile; sadece yeni hatalar sayılır (uyarılar bloklamaz) |
| `commands.format` | `{{files}}` ile; her developer turundan sonra otomatik çalışır |
| `linkDirs` | Repodan worktree'ye bağlanan klasörler (`node_modules` gibi) |
| `paths.edit` / `paths.readDeny` | Developer'ın yazabileceği yollar / hiçbir rolün okuyamayacağı dosyalar |
| `agent` / `cursor.*` | Ajan aracı (`auto`, `claude`, `cursor`) ve Cursor ayarları |
| `budgets` / `maxIterations` | Dolar bütçeleri (Claude) / developer ⇄ reviewer tur sayısı |
| `tech` | Teknoloji özeti (init üretir, düzenlenebilir) |

## Geliştirme

kgflow'un kendisi üzerinde çalışacaksan istediğin bir klasöre clone'layıp oradan kur; komut doğrudan o klasörü kullanır:

```bash
git clone https://github.com/yunusemre/flowloop.git && cd flowloop && ./install.sh
npm test   # 93 test: politika, kabuk ayrıştırıcı, odaklı kontroller, Cursor hook'ları, kurulum ve sahte ajanla uçtan uca akış
```

### Sürüm çıkarmak

Değişiklikleri `CHANGELOG.md`'ye yazdıktan sonra:

```bash
npm run release -- minor     # testler + package.json sürümü + "chore(release): x.y.z" commit'i + vX.Y.Z etiketi
git push --follow-tags
```

Hata düzeltmesi için `patch`, uyumsuz değişiklik için `major` kullanılır. Ekiptekiler `kgflow update` ile yeni sürüme geçer.
