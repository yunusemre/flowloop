# kgflow Kullanım Kılavuzu

kgflow, bir Jira görevini dört rollü bir AI ekibine yaptırır ve sonucu push'lanmış bir branch, PR bağlantısı ve Jira yorumu olarak teslim eder. Merge her zaman insandadır.

```
Jira görevi ─► ANALİST ─► plan ─► DEVELOPER ─► otomatik kontroller ─► REVIEWER ─(PASS)─► COMMITTER ─► push + Jira yorumu
                                     ▲                                    │
                                     └──────────── FAIL (geri bildirim) ◄─┘
```

| Rol | Ne yapar | Ne yapamaz |
|---|---|---|
| Analist | Görevi ve kodu okur, kabul kriterleri ve test planıyla plan yazar | Kod değiştiremez |
| Developer | Planı uygular, bu işin testlerini yazar | Commit atamaz, izinli yollar dışına yazamaz |
| Reviewer | Kodu inceler, kodu bilerek bozup testlerin yakalayıp yakalamadığını dener (mutasyon testi), PASS/FAIL verir | Gerçek dosyaları değiştiremez |
| Committer | Onaylanan değişikliği commit'ler, Jira özetini yazar | Kod değiştiremez, push/force push yapamaz |

Bu kurallar prompt'la değil kodla zorlanır: bir rol yetkisi dışında bir şey denerse işlem engellenir ve raporda görünür.

---

## 1. Gereksinimler

| Gereksinim | Not |
|---|---|
| macOS ya da Linux | |
| **Node.js 20 veya üstü** | Yoksa `install.sh` en güncel LTS sürümünü kurar |
| git | macOS: `xcode-select --install` |
| Claude **ya da** Cursor erişimi | Claude Code girişi (`claude` → `/login`) ya da `ANTHROPIC_API_KEY`. Claude yoksa Cursor CLI kullanılır (bkz. [Cursor ile kullanım](#claude-yerine-cursor)) |
| Jira API token | `kgflow run IDT-xxxx` için (bkz. [Jira](#3-jira-erişimi)) |
| Bitbucket/GitHub push yetkisi | Branch'ler otomatik push'lanır |

## 2. Kurulum

```bash
cd ~/Desktop/kgflow
./install.sh
```

Betik sırasıyla şunları yapar:

1. git'i kontrol eder.
2. Node.js'i kontrol eder. Yoksa ya da v20'den eskiyse **en güncel LTS** sürümünü [nvm](https://github.com/nvm-sh/nvm) ile kurar. nvm sudo istemez ve kendini `~/.zshrc` dosyasına ekler.
3. Claude, Cursor ve Jira erişimini kontrol eder (sadece uyarır, bir şey kurmaz).
4. Bağımlılıkları kurar, derler ve `kgflow` komutunu sisteme ekler (`npm link`).

Seçenekler:

```bash
./install.sh --check                  # hiçbir şey kurmadan ortamı kontrol et
KGFLOW_NODE=latest ./install.sh       # LTS yerine en güncel (Current) Node sürümünü kur
KGFLOW_FORCE_NVM=1 ./install.sh       # Node kurulu olsa bile nvm ile kur (npm link yetki hatası verirse)
```

Betiği tekrar çalıştırmak güvenlidir; kurulu olanları atlar. kgflow'un yeni bir sürümünü aldığında da aynı komutu çalıştır.

Kurulumu doğrula:

```bash
kgflow --help
```

## 3. Jira erişimi

1. https://id.atlassian.com/manage-profile/security/api-tokens adresinden bir API token oluştur.
2. `~/.zshrc` dosyasına ekle:

   ```bash
   export JIRA_EMAIL="ad.soyad@kolaygelsin.com"
   export JIRA_API_TOKEN="<token>"
   ```

3. Yeni bir terminal aç ya da `source ~/.zshrc` çalıştır.

Jira adresi (`https://kolaygelsin.atlassian.net`) varsayılan olarak tanımlı; ayrıca ayarlamaya gerek yok. Token'ı asla repoya ya da `kgflow.yaml`'a yazma.

## 4. Bir projeye eklemek (proje başına bir kez)

```bash
cd ~/Desktop/WORK/KG/kgs-app
kgflow init
kgflow check
git add .gitignore && git commit -m "chore: kgflow klasörünü gitignore'a ekle"
```

`kgflow init` şunları yapar:

- **Teknolojiyi algılar:** React Native/Expo, React, Next.js, Node, NestJS ya da .NET. Test, tip kontrolü, lint ve format komutlarını projenin kendi araçlarına göre seçer.
- **Base branch'i bulur:** production → main → master sırasıyla bakar.
- **Branch adı kalıbını belirler:** mevcut branch'ler Jira anahtarıyla başlıyorsa (`IDT-123-...`) aynı kalıbı kullanır.
- **Kuralları bulur:** projedeki `CLAUDE.md`, `.cursorrules` gibi kural dosyalarını ve kişisel `~/.claude/CLAUDE.md` dosyanı otomatik dahil eder. Kod hafızası MCP'sini (claude-code-memory) de bulur.
- **Ayar dosyasını oluşturur:** `.kgflow/kgflow.yaml`.
- **`.gitignore`'ı günceller:** `.kgflow/` satırını ekler; dosya yoksa oluşturur.

`kgflow check` rollerin yetkilerini, komutları ve bulunan kural dosyalarını gösterir. Komutlarda bir sorun varsa `.kgflow/kgflow.yaml`'ı düzenle.

## 5. Günlük kullanım

```bash
cd ~/Desktop/WORK/KG/kgs-app
kgflow run IDT-24057 --plan-onayi -v
```

| Seçenek | Anlamı |
|---|---|
| `--plan-onayi` | Analist planı yazdıktan sonra durur ve onay ister. **Önerilir.** |
| `-v` | Ajanların ne yaptığını canlı gösterir |
| `--refresh` | Görev dosyası daha önce çekildiyse bile Jira'dan yeniden çeker |
| `--no-push` | Bu seferlik push yapmaz |
| `--agent claude\|cursor` | Ajan aracını bu seferlik seç |
| `--dry-run` | Ajan çalıştırmadan prompt'ları ve yetkileri gösterir (ücretsiz) |

Akış:

1. **Görev:** Jira kaydı `.kgflow/tasks/IDT-24057.md` dosyasına çekilir. Bu dosyayı düzenleyip tekrar çalıştırabilirsin; `--refresh` vermedikçe üzerine yazılmaz.
2. **Çalışma alanı:** base branch'ten temiz bir kopya (git worktree) açılır. Senin çalışma klasörüne hiç dokunulmaz.
3. **Plan:** analist planı yazar. `--plan-onayi` verdiysen planı okuyup onaylarsın.
4. **Geliştirme döngüsü** (en fazla 3 tur):
   - Developer kodu yazar.
   - kgflow değişen dosyaları formatlar ve otomatik kontrolleri çalıştırır: bu işin testleri, **yeni** tip hataları, **yeni** lint hataları. Projede zaten var olan hatalar sayılmaz.
   - Kontroller geçerse reviewer inceler. FAIL verirse geri bildirimi developer'a döner ve yeni tur başlar.
5. **Teslim:** reviewer PASS verince committer commit'ler. Branch push'lanır, PR bağlantısı verilir ve Jira kaydına özet yorum düşer.

Bittiğinde ekranda şunlar görünür:

```
── BİTTİ
  a1b2c3d feat(harita): görevdeki birden fazla gönderiyi ayrı işaretle göster

  Branch  : IDT-24057-haritada-task-icerisinde-birden-fazla-gonderi-gibi
  Maliyet : $2.84 · 2 tur · 0 reddedilen işlem

  Push    : origin/IDT-24057-haritada-task-icerisinde-birden-fazla-gonderi-gibi ✓
  PR aç   : https://bitbucket.org/sendeotech/kgs-app/pull-requests/new?source=...
  Jira    : https://kolaygelsin.atlassian.net/browse/IDT-24057?focusedCommentId=...
```

Sonra PR'ı açıp normal kod incelemesini yaparsın.

### Jira'ya düşen yorum

- **Committer'ın yazdığı kısım:** Sorun, Yapılan, Neden bu yaklaşım, Nasıl test edildi.
- **kgflow'un eklediği kısım:** branch, commit'ler, PR bağlantısı.
- **İmza:** "Claude ile hazırlandı", kullanılan modeller ve işi başlatan kişi. Commit'lerdeki `Co-Authored-By: Claude` satırı da işi kimin yaptığını gösterir.

## Claude yerine Cursor

Claude erişimi yoksa kgflow ajanları **Cursor CLI** ile çalıştırır. Seçim otomatiktir:

| `agent` ayarı | Davranış |
|---|---|
| `auto` (varsayılan) | Claude girişi ya da `ANTHROPIC_API_KEY` varsa Claude, yoksa Cursor |
| `claude` | Her zaman Claude |
| `cursor` | Her zaman Cursor |

Tek seferlik seçim için `kgflow run IDT-1234 --agent cursor` kullanılır. Hangisinin seçileceğini `kgflow check` gösterir; çalıştırma başında da ekrana yazılır.

Cursor CLI kurulumu:

```bash
curl https://cursor.com/install -fsS | bash
cursor-agent login
```

Cursor ile de aynı kurallar geçerlidir. Rol yetkileri yine kodla zorlanır: kgflow çalışma kopyasına geçici bir `.cursor/hooks.json` yazar ve Cursor her komuttan ve her dosya işleminden önce kgflow'a sorar. Hook çalışmazsa işlem engellenir. Hook'ların hiç çalışmadığı fark edilirse o rolün sonucu kabul edilmez. Çalıştırma bitince bu dosyalar silinir; projenin kendi `.cursor/` dosyaları olduğu gibi geri konur.

Claude ile arasındaki farklar:

| | Claude | Cursor |
|---|---|---|
| Maliyet | Dolar olarak raporlanır, `budgets` ile sınırlanır | Cursor aboneliğinden düşer; rol başına süre sınırı (`cursor.timeoutMin`, varsayılan 30 dk) |
| Model | `model` / `roles.<rol>.model` | `cursor.model` ya da `roles.<rol>.model` (`cursor-agent --list-models`) |
| Kod hafızası (MCP) | Açılır (salt okuma) | Açılmaz |
| Mutasyon testi | Araç olarak | Kabuk komutu olarak (reviewer'a otomatik anlatılır) |
| Commit imzası | `Co-Authored-By: Claude` | `Co-Authored-By: Cursor Agent` |
| Jira imzası | "Claude ile hazırlandı" | "Cursor ile hazırlandı" |

## 6. Diğer komutlar

| Komut | Ne yapar |
|---|---|
| `kgflow runs` | Bu projedeki çalıştırmaları ve durumlarını listeler |
| `kgflow resume <id> -v [--agent cursor]` | Yarım kalan bir çalıştırmayı baştan başlatmadan sürdürür (kontroller → reviewer → commit → push → Jira) |
| `kgflow task IDT-123` | Sadece Jira görevini dosyaya çeker (çalıştırmaz) |
| `kgflow clean` | Merge edilmiş çalıştırmaların çalışma klasörlerini siler |
| `kgflow clean --all` | Tüm çalıştırmaların çalışma klasörlerini siler |
| `kgflow init --force` | Ayar dosyasını yeniler; elle girdiğin değerleri korur |

Çalıştırma kimliği (`<id>`) `kgflow runs` çıktısında ve hata mesajında yazar.

## 7. Ayarlar (`.kgflow/kgflow.yaml`)

En çok değiştirilenler:

| Alan | Açıklama |
|---|---|
| `baseBranch` | Boşsa production → main → master |
| `branchName` | `{{jira}}-{{slug}}` → `IDT-24057-haritada-task...` |
| `push` | İş bitince branch'i push'la (force push asla yapılmaz) |
| `jira.comment` | İş bitince Jira'ya yorum ekle |
| `commands.testRelated` | Bu işin testleri, ör. `npx jest --findRelatedTests {{files}} --passWithNoTests` |
| `commands.typecheck` | Ör. `npx tsc --noEmit -p .`; sadece yeni hatalar sayılır |
| `commands.lint` | Ör. `npx eslint --quiet {{files}}`; sadece yeni **hatalar** sayılır, uyarılar bloklamaz |
| `commands.format` | Ör. `npx prettier --write {{files}}`; her turdan sonra otomatik çalışır |
| `paths.edit` | Developer'ın değiştirebileceği yollar |
| `paths.readDeny` | Hiçbir rolün okuyamayacağı dosyalar (`.env` gibi) |
| `budgets` | Rol başına ve toplam dolar limiti |
| `maxIterations` | Developer ⇄ reviewer tur sayısı (varsayılan 3) |
| `agent` | `auto` / `claude` / `cursor` |
| `cursor.model` / `cursor.timeoutMin` | Cursor modeli / rol başına süre sınırı |

`{{files}}` yerine bu işte değişen dosyalar yazılır; testler, lint ve format sadece onlarda çalışır.

### Proje dersleri

Reviewer'ın ve kontrollerin reddettiği konular `.kgflow/lessons.md` dosyasına yazılır. Developer ve reviewer bu dosyayı sonraki her işte görür ve aynı hataları tekrarlamamaya çalışır.

## 8. Sorun giderme

| Belirti | Çözüm |
|---|---|
| `zsh: command not found: kgflow` | `./install.sh` çalıştır, sonra yeni bir terminal aç |
| `zsh: permission denied: kgflow` | `cd ~/Desktop/kgflow && npm run build` |
| `npm link` yetki hatası | `KGFLOW_FORCE_NVM=1 ./install.sh` (sudo'suz Node kurulumu) |
| `Jira yetki hatası (401)` | `JIRA_EMAIL` / `JIRA_API_TOKEN` değerlerini kontrol et; kayda erişimin olmalı |
| `N turda onay alınamadı` | Son geri bildirim `kgflow runs` ile bulunan klasördeki `run.json` dosyasında. Kontroller düzeldiyse `kgflow resume <id> -v` |
| `YENİ lint hatası` sürekli çıkıyor | Projede Prettier ile ESLint kuralları çakışıyor olabilir. `.eslintrc`'de `extends` listesinin sonuna `'prettier'` ekle |
| `IDT-…-2` gibi branch açıldı | Aynı adlı eski branch'te commit var. Eskisini incele ya da sil |
| `Ne Claude ne Cursor erişimi bulundu` | Claude Code'a giriş yap ya da Cursor CLI'yi kur ve `cursor-agent login` çalıştır |
| `Cursor hook'ları çalışmadı` | Cursor CLI eski olabilir: `cursor-agent update` |
| Cursor'da her yazma işlemi "yol belirtilmemiş" diye reddediliyor | Cursor'un hook formatı değişmiş olabilir; `run.json` içindeki `denials` listesine bak ve kgflow'u güncelle |
| Eski `.ekip` klasörü | İlk `kgflow` komutunda otomatik `.kgflow`'a taşınır |

## 9. Güvenlik

- Token'lar sadece ortam değişkeninden okunur, hiçbir dosyaya yazılmaz.
- `.env` gibi dosyalar hiçbir rol tarafından okunamaz (`paths.readDeny`).
- Ajanlar senin çalışma klasörünü değiştirmez; ayrı bir kopyada çalışırlar.
- Force push, `--no-verify` ve `--amend` engellidir. Commit hook'ları çalışır.
- Jira metni görev tanımı olarak kullanılır; içindeki talimatlar kgflow'un kurallarını ve rol yetkilerini değiştiremez.
- Kod hafızası (MCP) sadece okuma araçlarıyla açılır.
- Merge her zaman PR üzerinden bir insan tarafından yapılır.
