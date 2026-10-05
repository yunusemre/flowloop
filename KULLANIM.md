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
| Claude **ya da** Cursor erişimi | `kgflow setup` adım adım kurar (bkz. [Hesap bilgileri](#3-hesap-bilgileri-kgflow-setup)) |
| Jira API token | `kgflow setup` sorar ve doğrular |
| Bitbucket/GitHub push yetkisi | Branch'ler otomatik push'lanır |

## 2. Kurulum

Üç yol var; hepsi aynı `install.sh` betiğini kullanır ve sonunda aynı `kgflow` komutu kurulur.

### a) Tek komut, repoyu indirmeden (önerilen)

Bitbucket'a SSH erişimin varsa (`ssh -T git@bitbucket.org` ile kontrol edebilirsin):

```bash
curl -fsSL <install.sh adresi> | bash
```

`<install.sh adresi>`, betiğin ekipçe erişilebilir olduğu adrestir; bkz. [Betiği paylaşmak](#betiği-paylaşmak). Betik, kgflow'u şirket reposundan (`git@bitbucket.org:sendeotech/kgflow.git`) kendi gizli klasörüne (`~/.kgflow/src`) çeker, derler ve komutu kurar. Senin çalışma klasörlerinde hiçbir şey oluşmaz.

Betik adresi henüz yoksa, aynı işi curl'süz tek komutla da yapabilirsin:

```bash
git clone -q --depth 1 git@bitbucket.org:sendeotech/kgflow.git ~/.kgflow/src && KGFLOW_SOURCE=git@bitbucket.org:sendeotech/kgflow.git bash ~/.kgflow/src/install.sh
```

Farklı bir repo ya da dal için kaynağı `KGFLOW_SOURCE` ile ver:

```bash
curl -fsSL <install.sh adresi> | KGFLOW_SOURCE="git+ssh://git@bitbucket.org/sendeotech/kgflow.git#develop" bash
```

### b) Hazır paketten (.tgz)

Derlenmiş paket (`npm pack` ile üretilir) bir dosya ya da adres olarak paylaşılabilir. Derleme gerekmediği için en hızlısıdır:

```bash
curl -fsSL <install.sh adresi> | KGFLOW_SOURCE=https://.../kgflow-0.2.0.tgz bash
# ya da Node kuruluysa doğrudan:
npm install -g ./kgflow-0.2.0.tgz
```

### c) Repo klasöründen (kgflow'u geliştirenler için)

```bash
cd ~/Desktop/kgflow
./install.sh
```

Bu yolda kgflow doğrudan bu klasörden çalışır (`npm link`); klasördeki değişiklikler derlendiği anda geçerli olur.

### Betik ne yapar

1. git'i kontrol eder.
2. Node.js'i kontrol eder. Yoksa ya da v20'den eskiyse **en güncel LTS** sürümünü [nvm](https://github.com/nvm-sh/nvm) ile kurar. nvm sudo istemez ve kendini `~/.zshrc` dosyasına ekler.
3. kgflow'u kurar ve nereden kurulduğunu `~/.kgflow/install.json` dosyasına yazar. `kgflow update` bu kaydı kullanır.
4. `kgflow setup`'ı başlatır ve hesap bilgilerini sorar (bkz. [Hesap bilgileri](#3-hesap-bilgileri-kgflow-setup)). Atlamak için `KGFLOW_SKIP_SETUP=1`.

Seçenekler (curl ile kullanırken `| bash -s -- --check` biçiminde):

```bash
./install.sh --check                  # hiçbir şey kurmadan ortamı kontrol et
KGFLOW_NODE=latest ./install.sh       # LTS yerine en güncel (Current) Node sürümünü kur
KGFLOW_FORCE_NVM=1 ./install.sh       # Node kurulu olsa bile nvm ile kur (npm yetki hatası verirse)
```

Kurulumu doğrula:

```bash
kgflow --version     # sürüm ve kurulum kaynağı
```

### Güncelleme

```bash
kgflow update
```

kgflow kurulduğu kaynağa göre güncellenir:

| Nasıl kuruldu | `kgflow update` ne yapar |
|---|---|
| Tek komut (git kaynağı) | Kaynaktan en son hâli çeker, yeniden derler ve kurar |
| Hazır paket (.tgz) | Aynı adresten paketi yeniden kurar |
| Repo klasöründen | Klasörde `git pull` yapar, sonra `install.sh` çalıştırır |

Yeni bir sürüm çıktığında `kgflow run`, `check` ve `init` komutları ekranın başında haber verir. Bu kontrol günde en fazla bir kez yapılır, birkaç saniyeden uzun sürmez ve ağ yoksa sessizce atlanır. Kapatmak için `export KGFLOW_NO_UPDATE_CHECK=1`.

Projelerdeki `.kgflow/` ayarları ve dersler güncellemeden etkilenmez. Yeni sürüm yeni ayarlar getirdiyse `kgflow init --force` mevcut değerlerini koruyarak şablonu yeniler.

### Betiği paylaşmak

Tek komutlu kurulum için `install.sh`'ın ekipçe erişilebilir bir adreste durması gerekir. Betikte gizli bilgi yoktur; kgflow'un kendisi yine SSH ile, sadece erişimi olanlara indirilir. Seçenekler:

- **Bitbucket (repo gizliyse):** API token ile ham dosya adresi:
  `curl -fsSL -u <e-posta>:<api-token> https://api.bitbucket.org/2.0/repositories/sendeotech/kgflow/src/main/install.sh | bash`
- **Şirket içi bir web sunucusu ya da wiki eki:** `install.sh`'ı oraya koy, adresini paylaş.
- **Hazır paket:** `npm pack` ile üretilen `.tgz`'yi aynı yere koy; en hızlı kurulum budur.

## 3. Hesap bilgileri (`kgflow setup`)

Kurulumun sonunda `kgflow setup` kendiliğinden başlar ve gereken bilgileri adım adım sorar. Her adımda bilginin nereden alınacağını gösterir, gerekirse ilgili sayfayı tarayıcıda açar ve girdiğin bilgiyi doğrular. Daha sonra istediğin zaman tekrar çalıştırabilirsin:

```bash
kgflow setup            # eksikleri sorar; hazır olanları sadece doğrular
kgflow setup --force    # hepsini baştan sorar (ör. token yenilemek için)
kgflow setup --check    # soru sormadan durumu gösterir (Jira ve Bitbucket'a bağlanıp dener)
```

| Adım | Ne sorulur | Nereden alınır | Nasıl doğrulanır |
|---|---|---|---|
| 1. Kimlik | Ad soyad, iş e-postan | Zaten `git config`'te varsa sorulmaz | Commit'lerde ve Jira yorumunda "Başlatan" olarak görünür |
| 2. AI erişimi | Üç seçenekten biri (aşağıda) | — | Claude Code girişi varsa sorulmaz |
| 3. Jira | Atlassian e-postan ve API token | https://id.atlassian.com/manage-profile/security/api-tokens → **Create API token** | Jira'ya bağlanılır, adın gösterilir ("Jira doğrulandı: Yunus Emre Tatar") |
| 4. Bitbucket | Bir şey sorulmaz, SSH erişimi denenir | Yoksa SSH anahtarı oluşturulur, panoya kopyalanır ve https://bitbucket.org/account/settings/ssh-keys/ açılır | `ssh -T git@bitbucket.org` |

**AI erişimi seçenekleri:**

1. **Claude aboneliği (Pro/Max/Team):** Claude Code kurulu değilse kurulur. Ardından `claude setup-token` çalışır: tarayıcıda Claude hesabınla giriş yaparsın, terminalde bir token görünür, onu kgflow'a yapıştırırsın. Bu token bir yıl geçerlidir ve sadece model isteği yapabilir.
2. **Anthropic API anahtarı:** https://console.anthropic.com/settings/keys → **Create Key**. Kullanım başına ücretlendirilir. Anahtar kaydedilmeden önce doğrulanır.
3. **Cursor:** Cursor CLI kurulu değilse kurulur, ardından `cursor-agent login` ile giriş yapılır.

Bilgisayarında Claude Code'a zaten giriş yaptıysan (`claude` → `/login`) bu adım atlanır; kgflow o girişi kullanır.

### Bilgiler nerede saklanır

| Sistem | Yer |
|---|---|
| macOS | Anahtar Zinciri (Keychain Access'te "kgflow" adıyla görünür) |
| Linux | Sistem anahtarlığı (`secret-tool`), yoksa `~/.kgflow/credentials.json` (sadece senin okuyabileceğin izinle) |

- Gizli bilgiler ekrana yazılmaz (yazarken `•` görünür), komut geçmişine ve hiçbir proje dosyasına girmez.
- **Ajanlara asla verilmez.** Ajanlar ve onların çalıştırdığı testler, gizli görünen hiçbir ortam değişkenini (`*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_API_KEY`, `JIRA_*`, `AWS_*`…) görmez. Sadece Claude'un kendi girişi için gereken bilgi Claude sürecine verilir.
- Ortam değişkeni tanımlıysa (ör. eskiden `~/.zshrc`'ye yazılmış `JIRA_API_TOKEN`) önce o kullanılır. `kgflow setup` ile kaydettikten sonra `~/.zshrc`'deki satırları silebilirsin.
- Bir bilgiyi silmek için: macOS'ta Keychain Access → "kgflow" kayıtlarını sil; Linux'ta `~/.kgflow/credentials.json`.

Jira adresi (`https://kolaygelsin.atlassian.net`) varsayılan olarak tanımlı; ayrıca ayarlamaya gerek yok.

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
| `zsh: command not found: kgflow` | Kurulumu tekrar çalıştır, sonra yeni bir terminal aç |
| `Kurulum kaydı bulunamadı` (`kgflow update`) | kgflow eski yöntemle kurulmuş; kurulumu bir kez yeniden çalıştır |
| `Kaynağa erişilemedi` | Bitbucket SSH erişimini kontrol et: `ssh -T git@bitbucket.org` |
| `zsh: permission denied: kgflow` | `cd ~/Desktop/kgflow && npm run build` |
| npm yetki hatası (`EACCES`) | `KGFLOW_FORCE_NVM=1` ile kur (sudo'suz Node kurulumu) |
| `Jira yetki hatası (401)` / `Jira kimlik bilgisi yok` | `kgflow setup --force` ile token'ı yenile; kayda erişimin olmalı |
| `N turda onay alınamadı` | Son geri bildirim `kgflow runs` ile bulunan klasördeki `run.json` dosyasında. Kontroller düzeldiyse `kgflow resume <id> -v` |
| `YENİ lint hatası` sürekli çıkıyor | Projede Prettier ile ESLint kuralları çakışıyor olabilir. `.eslintrc`'de `extends` listesinin sonuna `'prettier'` ekle |
| `IDT-…-2` gibi branch açıldı | Aynı adlı eski branch'te commit var. Eskisini incele ya da sil |
| `Ne Claude ne Cursor erişimi bulundu` | `kgflow setup` |
| `Cursor hook'ları çalışmadı` | Cursor CLI eski olabilir: `cursor-agent update` |
| Cursor'da her yazma işlemi "yol belirtilmemiş" diye reddediliyor | Cursor'un hook formatı değişmiş olabilir; `run.json` içindeki `denials` listesine bak ve kgflow'u güncelle |
| Eski `.ekip` klasörü | İlk `kgflow` komutunda otomatik `.kgflow`'a taşınır |

## 9. Güvenlik

- Token'lar sistemin anahtar zincirinde saklanır; hiçbir proje dosyasına yazılmaz ve ajanlara geçmez.
- `.env` gibi dosyalar hiçbir rol tarafından okunamaz (`paths.readDeny`).
- Ajanlar senin çalışma klasörünü değiştirmez; ayrı bir kopyada çalışırlar.
- Force push, `--no-verify` ve `--amend` engellidir. Commit hook'ları çalışır.
- Jira metni görev tanımı olarak kullanılır; içindeki talimatlar kgflow'un kurallarını ve rol yetkilerini değiştiremez.
- Kod hafızası (MCP) sadece okuma araçlarıyla açılır.
- Merge her zaman PR üzerinden bir insan tarafından yapılır.
