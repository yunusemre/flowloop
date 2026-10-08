# flowloop

Rol bazlı AI geliştirme ekibi. Bir Jira görevini alır, dört rolden geçirir ve sonucu push'lanmış bir branch, PR bağlantısı ve Jira yorumu olarak teslim eder. Merge her zaman insandadır.

```
Jira görevi ─► ANALİST ─► plan ─(senin onayın)─► DEVELOPER ─► otomatik kontroller ─► REVIEWER ─(PASS)─► SENİN ONAYIN ─► COMMITTER ─► push + Jira yorumu
                  ▲            │                    ▲          (format, bu işin testleri,           │              │
                  └── yorumun ─┘                    └── FAIL ── yeni tip/lint hataları) ◄────────────┘              │
                                                    └──────────────────── değişiklik isteğin ◄─────────────────────┘
```

Sen onaylamadan hiçbir şey commit'lenmez, push'lanmaz ve Jira'ya yazılmaz.

- **Belirsizlikte sorar:** analist ürün kararı gerektiren noktaları "Açık sorular" olarak yazar; cevaplanmadan geliştirmeye geçilmez. Cevabı sen verirsin ya da sorular Jira'ya yazılır, ürün sahibi cevaplar.
- **Birbirine bağlı görevleri birlikte ele alır:** `flowloop run IDT-1 IDT-2 IDT-3` (ya da `--epic IDT-100`) önce bütün görevleri okuyup sırayı, bağımlılıkları ve bütün soruları tek seferde çıkarır; sonra görevleri sırayla, aynı branch'te, her biri ayrı commit ve Jira yorumuyla yapar. Durursa aynı komut kaldığı yerden devam eder.
- **Bitince neye bakman gerektiğini söyler:** varsayımlar, reviewer'ın "incelenmesi önerilenler" notları ve developer'ın riskleri onay ekranında ve Jira yorumunda listelenir.

Ayrıntılı kılavuz: **[KULLANIM.md](KULLANIM.md)**

## Hızlı başlangıç

```bash
# 1) Kur: repoyu ~/.flowloop/src'ye indirir, Node yoksa kurar, flowloop komutunu ekler ve hesap kurulumunu başlatır
git clone https://github.com/yunusemre/flowloop.git ~/.flowloop/src && ~/.flowloop/src/install.sh

# 2) Projeye ekle (proje başına bir kez)
cd ~/projeler/my-app
flowloop init && flowloop check

# 3) Jira görevini çalıştır (--approve-plan: planı onayla, yorumla güncellet ya da iptal et)
#    Birbirine bağlı görevler: flowloop run IDT-1 IDT-2 IDT-3 --approve-plan -v  (ya da --epic IDT-100)
flowloop run PROJ-1234 --approve-plan -v
```

| Komut | Ne yapar |
|---|---|
| `flowloop setup` | Hesapları adım adım kurar: git kimliği, Claude/Cursor, Jira, Bitbucket. Kurulum sonunda kendiliğinden açılır |
| `flowloop update` | flowloop'u günceller. Yeni sürüm çıkınca flowloop ekranın başında haber verir |
| `flowloop run IDT-1 IDT-2 …` / `--epic IDT-100` | Birbirine bağlı görevler: toplu plan, sonra sırayla tek branch'te |
| `flowloop runs` / `flowloop resume <id>` | Çalıştırmaları (toplu çalışmalar dahil) listeler / yarım kalanı sürdürür |
| `flowloop stats [--since 30d]` | Ölçüm özeti: başarı, ilk incelemede PASS, tur, insan müdahalesi, kapsam talepleri, reddedilen işlemler, maliyet |
| `flowloop --version` | Sürümü ve kurulum kaynağını gösterir |

Gereksinimler: macOS ya da Linux ve git. Node.js 20+ yoksa kurulum betiği kurar. Push için projenin kendi reposuna (ör. Bitbucket) erişimin olmalı.

## Roller

| Rol | Yapabilir | Yapamaz |
|---|---|---|
| Analist | Kodu ve proje kurallarını okur, kabul kriterli plan yazar; ilgili repolar varsa görevin repo kapsamını ve repolar arası sözleşmeyi planlar | Kod değiştirmek, komut çalıştırmak, `flowloop.yaml`'ın izin vermediği bir repoyu yazılabilir yapmak |
| Developer | `paths.edit` ve onaylanan repo kapsamı altını düzenler; bu işin testlerini ve lint'i çalıştırır; kapsam dışı bir değişiklik gerekirse kapsam talebi yazar | Başka dosya, kapsamı kendi genişletmek, tüm test suite'i, commit |
| Reviewer | Okur, testleri çalıştırır, kodu **kopyada** bozarak testleri dener (mutasyon testi), repolar arası sözleşme uyumunu kontrol eder, PASS/FAIL verir | Gerçek dosyaya yazmak, commit |
| Committer | `git add`, `git commit`, Jira özeti | Dosya düzenlemek, push, `--no-verify`, `--amend` |

Ajanlar [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) ile çalışır; Claude erişimi yoksa otomatik olarak Cursor CLI kullanılır (`agent: auto | claude | cursor`). İki durumda da yetkiler aynı kodla zorlanır.

## İlkeler

1. **Projenin kendi kuralları geçerlidir.** `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.cursor/rules/*.mdc` ve `.github/copilot-instructions.md` varsa bütün rollere verilir; kişisel `~/.claude/CLAUDE.md` de eklenir (çelişirse proje kuralı geçerli).
2. **Sadece bu işe odaklanılır.** Projede zaten var olan tip hataları, lint hataları ve kırık testler kimseyi bloklamaz. flowloop aynı kontrolleri dokunulmamış bir base kopyasında da çalıştırır ve sadece bu işle **gelen** hataları sayar. Lint uyarıları bloklamaz.
3. **Testler işe özeldir.** Tüm suite değil, değişen dosyalarla ilgili testler çalışır (Jest'te `--findRelatedTests`).
4. **Her zaman temiz bir çalışma alanı kullanılır.** İş, `origin`'den çekilen base branch (`production → main → master`) üzerinde açılan ayrı bir worktree'de yapılır; senin çalışma klasörüne dokunulmaz.
5. **Teknolojiye göre çalışılır.** `flowloop init` projeyi tanır (React Native/Expo, React, Next.js, Node, NestJS, .NET) ve test, tip kontrolü, lint ve format komutlarını projenin kendi araçlarına göre seçer.

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
- **Görev başına kapsam.** İlgili repolarda `edit` bir tavandır; analist planında bu görev için gereken repoları seçer, sen planla birlikte onaylarsın. Plan tavanı sadece daraltabilir; planda kapsam bölümü yoksa ilgili repolar salt okunur kalır. Developer kapsam dışı bir değişiklik gerektiğinde workaround yazmak yerine kapsam talebi yazar; döngü durur ve kararı sen verirsin (genişlet / genişletmeden devam / durdur).
- **Merge her zaman insandadır.** Force push asla yapılmaz; branch push'lanır ve PR bağlantısı verilir.

## Jira

`flowloop run PROJ-1234` görevi Jira'dan çeker. Analistin açık soruları istenirse kayda yorum olarak yazılır (`questions: jira` ya da onay ekranında **[j]**); cevaplar gelince `flowloop run PROJ-1234 --refresh` görevi yeniden çeker. İş bitince kayda kısa bir yorum eklenir: sorun / yapılan / neden bu yaklaşım / nasıl test edildi (committer yazar), varsayımlar, incelenmesi önerilenler, branch, commit'ler, PR bağlantısı, kullanılan modeller ve "insan incelemesi gerekir" notu. Commit'lerdeki `Co-Authored-By` satırı işi kimin yaptığını gösterir.

## Yapılandırma (`.flowloop/flowloop.yaml`)

| Alan | Açıklama |
|---|---|
| `baseBranch` | Boş bırakılırsa production → main → master sırasıyla seçilir |
| `branchName` | `{{jira}}-{{slug}}` ya da `flowloop/{{slug}}-{{date}}` |
| `push` | İş bitince branch'i origin'e gönder (`--no-push` ile tek seferlik kapatılır) |
| `jira.baseUrl` / `jira.comment` | Projeye özel Jira adresi (boşsa `flowloop setup`'ta girilen) / iş bitince kayda özet yorumu |
| `questions` | Analistin açık soruları: `ask` (terminalde sor; etkileşimsizse dur), `jira` (etkileşimsizse Jira'ya yaz ve dur), `assume` (varsayılanla devam). `--questions` ile tek seferlik ezilir |
| `commands.testRelated` | Bu işin testleri; `{{files}}` ya da `{{testFiles}}` içermek zorunda |
| `commands.typecheck` | Tüm projenin tip kontrolü; sadece yeni hatalar sayılır |
| `commands.lint` | `{{files}}` ile; sadece yeni hatalar sayılır (uyarılar bloklamaz) |
| `commands.format` | `{{files}}` ile; her developer turundan sonra otomatik çalışır |
| `linkDirs` | Repodan worktree'ye bağlanan klasörler (`node_modules` gibi) |
| `paths.edit` / `paths.readDeny` | Developer'ın yazabileceği yollar (varsayılan `**`, bütün repo) / hiçbir rolün okuyamayacağı ve yazamayacağı dosyalar |
| `agent` / `cursor.*` | Ajan aracı (`auto`, `claude`, `cursor`) ve Cursor ayarları |
| `related` | Bağımlı repolar (ör. backend): okunur ya da `edit` ile değiştirilebilir; her repo ayrı branch/commit/PR. `edit` tavandır: analist planda görev için gereken repoları seçer, plan sadece daraltabilir |
| `budgets` / `maxIterations` | Dolar bütçeleri (Claude) / developer ⇄ reviewer tur sayısı |
| `tech` | Teknoloji özeti (init üretir, düzenlenebilir) |

## Geliştirme

flowloop'un kendisi üzerinde çalışacaksan istediğin bir klasöre clone'layıp oradan kur; komut doğrudan o klasörü kullanır:

```bash
git clone https://github.com/yunusemre/flowloop.git && cd flowloop && ./install.sh
npm test   # 116 test: politika, kabuk ayrıştırıcı, odaklı kontroller, Cursor hook'ları, kurulum ve sahte ajanla uçtan uca akış
```

### Sürüm çıkarmak

Değişiklikleri `CHANGELOG.md`'ye yazdıktan sonra:

```bash
npm run release -- minor     # testler + package.json sürümü + "chore(release): x.y.z" commit'i + vX.Y.Z etiketi
git push --follow-tags
```

Hata düzeltmesi için `patch`, uyumsuz değişiklik için `major` kullanılır. Ekiptekiler `flowloop update` ile yeni sürüme geçer.

## Lisans notları

Developer rolünün kural seti Ponytail'den (MIT) uyarlanmıştır; ayrıntı: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
