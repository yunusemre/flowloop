# kgflow

Rol bazlı AI geliştirme ekibi. Bir görevi alır, dört rolden geçirir ve sonucu temiz bir branch'te bırakır:

```
görev.md ─► ANALİST ─► plan ─► DEVELOPER ─► otomatik kontroller ─► REVIEWER ─(PASS)─► COMMITTER ─► branch
                                   ▲              (format, bu işin testleri,          │
                                   └──── FAIL ──── yeni tip/lint hataları) ◄──────────┘
```

| Rol | Yapabilir | Yapamaz |
|---|---|---|
| Analist | Kodu ve proje kurallarını okur, plan yazar | Kod değiştirmek, komut çalıştırmak |
| Developer | `paths.edit` altını düzenler; bu işin testlerini, tip kontrolünü ve lint'i çalıştırır | Başka dosya, tüm test suite'i, commit |
| Reviewer | Okur, testleri çalıştırır, kodu **kopyada** bozarak testleri dener (mutasyon), PASS/FAIL verir | Gerçek dosyaya yazmak, commit |
| Committer | `git add`, `git commit` | Dosya düzenlemek, push, `--no-verify`, `--amend` |

Ajanlar [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) ile çalışır.

## İlkeler

1. **Projenin kendi kuralları geçerlidir.** `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.cursor/rules/*.mdc` ve `.github/copilot-instructions.md` dosyaları varsa otomatik olarak bütün rollere verilir. Etkileşimli süreç kuralları ("kullanıcıdan onay iste", "oturum başına N dosya") otomatik akışta uygulanmaz; kod kalitesi kuralları aynen geçerlidir.
2. **Sadece bu işe odaklanılır.** Projede zaten var olan tip hataları, lint bulguları ve kırık testler kimseyi bloklamaz. kgflow aynı kontrolleri dokunulmamış bir base kopyasında da çalıştırır ve sadece bu işle **gelen** hataları sayar. Değişen bir tip imzası başka bir dosyada hata çıkarırsa, o da bu işe sayılır.
3. **Testler işe özeldir.** Tüm suite değil, değişen dosyalarla ilgili testler çalışır (Jest'te `--findRelatedTests`, Vitest'te `related`). Mutasyon kontrolü de aynı testleri kullanır.
4. **Her zaman temiz bir çalışma alanı kullanılır.** İş, yerel klasöründen bağımsız olarak, `origin`'den çekilen base branch üzerinde açılan yeni bir worktree'de yapılır. Base sırası `production → main → master` şeklindedir; ayardan sabitlenebilir. Yerel klasörde commit'lenmemiş değişiklik olması akışı engellemez. Bağımlılıklar, lock dosyası aynıysa repodan bağlanır; değilse kurulur.
5. **Teknolojiye göre çalışılır.** `kgflow init` projeyi tanır (React Native/Expo, React, Next.js, Node, NestJS, .NET), test koşucusunu, tip kontrolünü, linter'ı ve formatter'ı bulur, önemli kütüphaneleri sürümleriyle listeler. Bu "Teknoloji" özeti bütün rollere verilir.

## Güvenlik modeli

- **Kodla yazılmış yetki politikası** (`src/policy.ts`):
  - Her araç çağrısı (okumalar dahil) bir `PreToolUse` hook'undan geçer.
  - Yollar gerçek konumlarına çözülür; symlink ya da `..` ile çalışma alanının dışına çıkılamaz.
  - Bash komutları tek ve basit olmak zorundadır (`&&`, `|`, `;`, `>`, `$()` yasak). Ayrıca rolün izinli komut önekiyle başlamalıdır; örneğin developer sadece `npx jest --findRelatedTests …` çalıştırabilir.
  - `readDeny` listesindeki dosyalar hiçbir rol tarafından okunamaz.
  - Kullanıcının plugin, skill ve MCP sunucuları ajanlara yüklenmez.
- **Git kontrolleri** (`src/orchestrator.ts`). Her aşamadan sonra çalışır:
  - Analist çalışma alanını değiştirmemiş olmalı.
  - Developer commit atmamış ve izinli yolların dışına yazmamış olmalı.
  - Reviewer gerçek dosyalara dokunmamış olmalı.
  - Commit'lenen içerik, onaylanan içeriğin tree hash'iyle birebir aynı olmalı. Commit hook'ları dosya değiştirirse bu kontrol yakalar.
  - Commit mesajları Conventional Commits formatında olmalı ya da `commitlint`'ten geçmeli.
- **Merge her zaman insandadır.** `push: true` ise branch iş bitince `origin`'e gönderilir (force push asla yapılmaz) ve PR bağlantısı verilir.

## Kurulum ve kullanım

Ayrıntılı kılavuz: **[KULLANIM.md](KULLANIM.md)**

Ajanlar Claude Agent SDK ile çalışır; Claude erişimi yoksa otomatik olarak Cursor CLI kullanılır (`agent: auto | claude | cursor`). İki durumda da rol yetkileri kodla zorlanır.

```bash
curl -fsSL <install.sh adresi> | bash     # repoyu indirmeden (ya da repo klasöründe: ./install.sh)
kgflow update                             # güncelleme
cd <proje> && kgflow init && kgflow check # proje başına bir kez
kgflow run IDT-1234 --plan-onayi -v       # Jira görevini çalıştır
```

## Jira

`kgflow run IDT-1234` görevi Jira'dan çeker (`JIRA_EMAIL` / `JIRA_API_TOKEN`). İş bitince `jira.comment: true` ise kayda kısa bir yorum eklenir:
sorun / yapılan / neden bu yaklaşım / nasıl test edildi (committer yazar) + branch, commit'ler, PR bağlantısı ve
"insan incelemesi gerekir" notu (kgflow ekler). Commit'lerdeki `Co-Authored-By: Claude` satırı kimin yaptığını gösterir.

## Yapılandırma (`.kgflow/kgflow.yaml`)

| Alan | Açıklama |
|---|---|
| `baseBranch` | Boş bırakılırsa production → main → master sırasıyla seçilir |
| `branchName` | `{{jira}}-{{slug}}` ya da `kgflow/{{slug}}-{{date}}` |
| `push` | İş bitince branch'i origin'e gönder (`--no-push` ile tek seferlik kapatılır) |
| `jira.baseUrl` / `jira.comment` | Jira adresi / iş bitince kayda özet yorumu |
| `commands.testRelated` | Bu işin testleri; `{{files}}` ya da `{{testFiles}}` içermek zorunda |
| `commands.typecheck` | Tüm projenin tip kontrolü; sadece yeni hatalar sayılır |
| `commands.lint` | `{{files}}` ile; sadece yeni hatalar sayılır (uyarılar bloklamaz) |
| `commands.format` | `{{files}}` ile; her developer turundan sonra otomatik çalışır |
| `linkDirs` | Repodan worktree'ye bağlanan klasörler (`node_modules` gibi) |
| `paths.edit` / `paths.readDeny` | Developer'ın yazabileceği yollar / hiçbir rolün okuyamayacağı dosyalar |
| `projectDocs` | Otomatik dahil edilen proje kural dosyaları |
| `tech` | Teknoloji özeti (init üretir, düzenlenebilir) |

## Geliştirme

```bash
npm test   # 79 test: politika, kabuk ayrıştırıcı, odaklı kontroller ve sahte ajanla uçtan uca akış
```
