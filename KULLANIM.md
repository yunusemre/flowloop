# flowloop Kullanım Kılavuzu

flowloop, bir Jira görevini dört rollü bir AI ekibine yaptırır ve sonucu push'lanmış bir branch, PR bağlantısı ve Jira yorumu olarak teslim eder. Merge her zaman insandadır.

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
| Claude **ya da** Cursor erişimi | `flowloop setup` adım adım kurar (bkz. [Hesap bilgileri](#3-hesap-bilgileri-flowloop-setup)) |
| Jira API token | `flowloop setup` sorar ve doğrular |
| Bitbucket/GitHub push yetkisi | Branch'ler otomatik push'lanır |

## 2. Kurulum

### a) Tek komut (önerilen)

Sadece git yeterli (repo herkese açık, giriş gerekmez):

```bash
git clone https://github.com/yunusemre/flowloop.git ~/.flowloop/src && ~/.flowloop/src/install.sh
```

Bu komut flowloop'u gizli bir klasöre (`~/.flowloop/src`) indirir ve oradan kurar; senin çalışma klasörlerinde hiçbir şey oluşmaz. Node.js yoksa kurulur, sonunda `flowloop setup` başlar. Güncellemeler `flowloop update` ile bu klasöre çekilir.

`~/.flowloop/src` zaten varsa (daha önce kurduysan) tekrar clone'lamaya gerek yok; `flowloop update` yeterli.

Farklı bir dal için: `git clone -b develop https://github.com/yunusemre/flowloop.git ~/.flowloop/src && ~/.flowloop/src/install.sh`

### b) Hazır paketten (.tgz)

Derlenmiş paket (`npm pack` ile üretilir) bir dosya ya da adres olarak paylaşılabilir. Derleme gerekmediği için en hızlısıdır:

```bash
npm install -g ./flowloop-0.2.0.tgz     # Node kurulu olmalı
```

Bu yolda `flowloop setup`'ı kendin çalıştırman gerekir; güncellemek için yeni paketi aynı komutla kurarsın.

### c) Kendi klasörüne (flowloop'u geliştirenler için)

```bash
git clone https://github.com/yunusemre/flowloop.git && cd flowloop && ./install.sh
```

a) yolundan tek farkı klasörün yeri: flowloop doğrudan bu klasörden çalışır (`npm link`), klasördeki değişiklikler derlendiği anda geçerli olur.

### Betik ne yapar

1. git'i kontrol eder.
2. Node.js'i kontrol eder. Yoksa ya da v20'den eskiyse **en güncel LTS** sürümünü [nvm](https://github.com/nvm-sh/nvm) ile kurar. nvm sudo istemez ve kendini `~/.zshrc` dosyasına ekler.
3. flowloop'u kurar ve nereden kurulduğunu `~/.flowloop/install.json` dosyasına yazar. `flowloop update` bu kaydı kullanır.
4. `flowloop setup`'ı başlatır ve hesap bilgilerini sorar (bkz. [Hesap bilgileri](#3-hesap-bilgileri-flowloop-setup)). Atlamak için `FLOWLOOP_SKIP_SETUP=1`.

Seçenekler:

```bash
./install.sh --check                  # hiçbir şey kurmadan ortamı kontrol et
FLOWLOOP_NODE=latest ./install.sh       # LTS yerine en güncel (Current) Node sürümünü kur
FLOWLOOP_FORCE_NVM=1 ./install.sh       # Node kurulu olsa bile nvm ile kur (npm yetki hatası verirse)
```

Kurulumu doğrula:

```bash
flowloop --version     # sürüm ve kurulum kaynağı
```

### Güncelleme

```bash
flowloop update
```

flowloop kurulduğu kaynağa göre güncellenir:

| Nasıl kuruldu | `flowloop update` ne yapar |
|---|---|
| Tek komut (`~/.flowloop/src`) ya da kendi klasörün | Klasörde `git pull` yapar, sonra yeniden derleyip kurar |
| Hazır paket (.tgz) | Kullanılmaz; yeni paketi aynı şekilde `npm install -g` ile kur |

Yeni bir sürüm çıktığında `flowloop run`, `check` ve `init` komutları ekranın başında haber verir. Bu kontrol günde en fazla bir kez yapılır, birkaç saniyeden uzun sürmez ve ağ yoksa sessizce atlanır. Kapatmak için `export FLOWLOOP_NO_UPDATE_CHECK=1`.

Projelerdeki `.flowloop/` ayarları ve dersler güncellemeden etkilenmez. Yeni sürüm yeni ayarlar getirdiyse `flowloop init --force` mevcut değerlerini koruyarak şablonu yeniler.

## 3. Hesap bilgileri (`flowloop setup`)

Kurulumun sonunda `flowloop setup` kendiliğinden başlar ve gereken bilgileri adım adım sorar. Her adımda bilginin nereden alınacağını gösterir, gerekirse ilgili sayfayı tarayıcıda açar ve girdiğin bilgiyi doğrular. Daha sonra istediğin zaman tekrar çalıştırabilirsin:

```bash
flowloop setup            # eksikleri sorar; hazır olanları sadece doğrular
flowloop setup --force    # hepsini baştan sorar (ör. token yenilemek için)
flowloop setup --check    # soru sormadan durumu gösterir (Jira ve Bitbucket'a bağlanıp dener)
```

| Adım | Ne sorulur | Nereden alınır | Nasıl doğrulanır |
|---|---|---|---|
| 1. Kimlik | Ad soyad, iş e-postan | Zaten `git config`'te varsa sorulmaz | Commit'lerde ve Jira yorumunda "Başlatan" olarak görünür |
| 2. AI erişimi | Üç seçenekten biri (aşağıda) | — | Claude Code girişi varsa sorulmaz |
| 3. Jira | Jira adresi, Atlassian e-postan ve API token | https://id.atlassian.com/manage-profile/security/api-tokens → **Create API token** | Jira'ya bağlanılır, adın gösterilir ("Jira doğrulandı: Yunus Emre Tatar") |
| 4. Bitbucket | Bir şey sorulmaz, SSH erişimi denenir | Yoksa SSH anahtarı oluşturulur, panoya kopyalanır ve https://bitbucket.org/account/settings/ssh-keys/ açılır | `ssh -T git@bitbucket.org` |

**AI erişimi seçenekleri:**

1. **Claude aboneliği (Pro/Max/Team):** Claude Code kurulu değilse kurulur. Ardından `claude setup-token` çalışır: tarayıcıda Claude hesabınla giriş yaparsın, terminalde bir token görünür, onu flowloop'a yapıştırırsın. Bu token bir yıl geçerlidir ve sadece model isteği yapabilir.
2. **Anthropic API anahtarı:** https://console.anthropic.com/settings/keys → **Create Key**. Kullanım başına ücretlendirilir. Anahtar kaydedilmeden önce doğrulanır.
3. **Cursor:** Cursor CLI kurulu değilse kurulur, ardından `cursor-agent login` ile giriş yapılır.

Bilgisayarında Claude Code'a zaten giriş yaptıysan (`claude` → `/login`) bu adım atlanır; flowloop o girişi kullanır.

### Bilgiler nerede saklanır

| Sistem | Yer |
|---|---|
| macOS | Anahtar Zinciri (Keychain Access'te "flowloop" adıyla görünür) |
| Linux | Sistem anahtarlığı (`secret-tool`), yoksa `~/.flowloop/credentials.json` (sadece senin okuyabileceğin izinle) |

- Gizli bilgiler ekrana yazılmaz (yazarken `•` görünür), komut geçmişine ve hiçbir proje dosyasına girmez.
- **Ajanlara asla verilmez.** Ajanlar ve onların çalıştırdığı testler, gizli görünen hiçbir ortam değişkenini (`*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_API_KEY`, `JIRA_*`, `AWS_*`…) görmez. Sadece Claude'un kendi girişi için gereken bilgi Claude sürecine verilir.
- Ortam değişkeni tanımlıysa (ör. eskiden `~/.zshrc`'ye yazılmış `JIRA_API_TOKEN`) önce o kullanılır. `flowloop setup` ile kaydettikten sonra `~/.zshrc`'deki satırları silebilirsin.
- Bir bilgiyi silmek için: macOS'ta Keychain Access → "flowloop" kayıtlarını sil; Linux'ta `~/.flowloop/credentials.json`.

### Jira adresi

Jira adresi kodun içinde sabit değildir; `flowloop setup` Jira adımında sorar (öneri olarak `https://kolaygelsin.atlassian.net` gelir, Enter ile kabul edilir). `kolaygelsin`, `kolaygelsin.atlassian.net` ya da tarayıcıdan kopyalanmış bir kayıt bağlantısı da yazılabilir; tam adrese çevrilir. Adres `~/.flowloop/config.json` dosyasına kaydedilir ve bütün projelerde kullanılır.

Öncelik sırası:

1. Projenin `.flowloop/flowloop.yaml` dosyasındaki `jira.baseUrl` (o projeye özel adres)
2. `JIRA_BASE_URL` ortam değişkeni
3. `flowloop setup`'ta girilen adres

Değiştirmek için `flowloop setup --force`.

Adres bir kez girildikten sonra görevler sadece anahtarla çalıştırılır: `flowloop run IDT-24057`. Tarayıcıdan kopyaladığın bağlantıyı yapıştırırsan da çalışır; anahtar bağlantıdan alınır.

## 4. Bir projeye eklemek (proje başına bir kez)

```bash
cd ~/Desktop/WORK/KG/kgs-app
flowloop init
flowloop check
git add .gitignore && git commit -m "chore: flowloop klasörünü gitignore'a ekle"
```

`flowloop init` şunları yapar:

- **Teknolojiyi algılar:** React Native/Expo, React, Next.js, Node, NestJS ya da .NET. Test, tip kontrolü, lint ve format komutlarını projenin kendi araçlarına göre seçer.
- **Base branch'i bulur:** production → main → master sırasıyla bakar.
- **Branch adı kalıbını belirler:** mevcut branch'ler Jira anahtarıyla başlıyorsa (`IDT-123-...`) aynı kalıbı kullanır.
- **Kuralları bulur:** projedeki `CLAUDE.md`, `.cursorrules` gibi kural dosyalarını ve kişisel `~/.claude/CLAUDE.md` dosyanı otomatik dahil eder. Kod hafızası MCP'sini (claude-code-memory) de bulur.
- **Ayar dosyasını oluşturur:** `.flowloop/flowloop.yaml`.
- **`.gitignore`'ı günceller:** `.flowloop/` satırını ekler; dosya yoksa oluşturur.

`flowloop check` rollerin yetkilerini, komutları ve bulunan kural dosyalarını gösterir. Komutlarda bir sorun varsa `.flowloop/flowloop.yaml`'ı düzenle.

## 5. Günlük kullanım

```bash
cd ~/Desktop/WORK/KG/kgs-app
flowloop run IDT-24057 --plan-onayi -v
```

| Seçenek | Anlamı |
|---|---|
| `--plan-onayi` | Analist planı yazdıktan sonra durur ve onay ister. **Önerilir.** |
| `-v` | Ajanların ne yaptığını canlı gösterir |
| `--refresh` | Görev dosyası daha önce çekildiyse bile Jira'dan yeniden çeker |
| `--no-push` | Bu seferlik push yapmaz |
| `--agent claude\|cursor` | Ajan aracını bu seferlik seç |
| `--dry-run` | Ajan çalıştırmadan prompt'ları ve yetkileri gösterir (ücretsiz) |
| `--onaysiz` | İş bitince değişiklikleri sormadan commit/push eder (önerilmez) |

Akış:

1. **Görev:** Jira kaydı `.flowloop/tasks/IDT-24057.md` dosyasına çekilir. Bu dosyayı düzenleyip tekrar çalıştırabilirsin; `--refresh` vermedikçe üzerine yazılmaz.
2. **Çalışma alanı:** base branch'ten temiz bir kopya (git worktree) açılır. Senin çalışma klasörüne hiç dokunulmaz.
3. **Plan:** analist planı yazar. `--plan-onayi` verdiysen planı okursun; onaylayabilir, yorum yazıp güncelletebilir ya da iptal edebilirsin (bkz. [Plan onayı](#plan-onayı)).
4. **Geliştirme döngüsü** (en fazla 3 tur):
   - Developer kodu yazar.
   - flowloop değişen dosyaları formatlar ve otomatik kontrolleri çalıştırır: bu işin testleri, **yeni** tip hataları, **yeni** lint hataları. Projede zaten var olan hatalar sayılmaz.
   - Kontroller geçerse reviewer inceler. FAIL verirse geri bildirimi developer'a döner ve yeni tur başlar.
5. **Senin onayın:** reviewer PASS verince iş **commit'lenmeden önce** sana gösterilir; onaylayabilir, değişiklik isteyebilir ya da bekletebilirsin (bkz. [Değişiklik onayı](#değişiklik-onayı)).
6. **Teslim:** onay verince committer commit'ler. Branch push'lanır, PR bağlantısı verilir ve Jira kaydına özet yorum düşer.

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

### Plan onayı

`--plan-onayi` ile çalıştırdığında analist planı yazınca şu soru gelir:

```
Plan uygun mu?
  [e] Onayla, geliştirmeye geç
  [y] Yorum yaz — analist yorumunu değerlendirip planı güncellesin
  [h] İptal (plan saklanır; görevi yeniden çalıştırınca bu plandan devam edilir)
```

- **[y] Yorum:** istediğin kadar satır yazabilirsin, bitirmek için boş bir satırda Enter'a basarsın. Analist yorumunu ve mevcut planı birlikte değerlendirir, planı günceller ve neyi değiştirdiğini özetler. Katılmadığı ya da uygulanamayan bir nokta varsa (ör. developer'ın değiştiremeyeceği bir dosya) planı değiştirmez, "Geri bildirime yanıt" başlığıyla nedenini yazar. Güncel plan tekrar sana sorulur. Önceki turların yorumları da analiste hatırlatılır; en fazla 5 tur yenilenebilir.
- **[h] İptal:** analiz boşa gitmez. Plan saklanır; aynı görevi tekrar `flowloop run IDT-1234 --plan-onayi` ile çalıştırdığında analist yeniden çalışmaz, aynı plan karşına gelir. O zaman ek olarak **[b] Bu planı kullanma, baştan analiz et** seçeneği de çıkar.
- Verdiğin yorumlar çalıştırma kaydında (`run.json` → `planFeedback`) ve `run/plan-feedback.md` dosyasında durur.

### Değişiklik onayı

Reviewer işi onayladıktan sonra hiçbir şey commit'lenmeden, push'lanmadan ve Jira'ya yazılmadan önce şunu görürsün:

```
━━ İŞ TAMAMLANDI — commit'ten önce senin onayın gerekiyor ━━
Reviewer: (değerlendirmenin özeti)

Değişen dosyalar:
 src/screens/Map/MapScreen.tsx      | 42 +++++++++----
 src/screens/Map/MapScreen.test.tsx | 88 ++++++++++++++++++++++++

Kodu editöründe de açabilirsin: ~/.flowloop/work/kgs-app/<çalıştırma>/wt

Değişiklikler uygun mu?
  [e] Onayla — commit, push ve Jira yorumu
  [d] Farkın tamamını göster
  [y] Değişiklik iste — yorumun developer'a gider, testler ve reviewer tekrar çalışır
  [h] Şimdilik onaylama — commit yapılmaz, sonra: flowloop resume
```

- **[d] Fark:** bütün değişiklikler satır satır gösterilir (yeni dosyalar dahil). Gösterilen yol editörde de açılabilir.
- **[y] Değişiklik iste:** birden fazla satır yazabilirsin, bitirmek için boş satırda Enter. Yorumun developer'a öncelikli istek olarak gider; developer mevcut çalışmanın üzerine uygular, otomatik kontroller çalışır ve reviewer isteğinin karşılanıp karşılanmadığını da kontrol eder. Sonuç sana tekrar sorulur. Önceki isteklerin de hatırlatılır.
- **[h] Şimdilik onaylama:** commit yapılmaz, çalışma alanı olduğu gibi kalır. İncelemeyi bitirince `flowloop resume <id>` aynı soruyu tekrar sorar ve onay verirsen commit/push/Jira yapılır. (Sürdürmede değişiklik isteği yoktur; o durumda isteği görev dosyasına ekleyip görevi yeniden çalıştır.)
- Değişiklik isteklerin `run.json` (`changeRequests`) ve `run/change-requests.md` içinde durur.

Soru sadece etkileşimli bir terminalde sorulur. Sormadan commit'lemek için `--onaysiz` verilir.

### Jira'ya düşen yorum

- **Committer'ın yazdığı kısım:** Sorun, Yapılan, Neden bu yaklaşım, Nasıl test edildi.
- **flowloop'un eklediği kısım:** branch, commit'ler, PR bağlantısı.
- **İmza:** "Claude ile hazırlandı", kullanılan modeller ve işi başlatan kişi. Commit'lerdeki `Co-Authored-By: Claude` satırı da işi kimin yaptığını gösterir.

## Claude yerine Cursor

Claude erişimi yoksa flowloop ajanları **Cursor CLI** ile çalıştırır. Seçim otomatiktir:

| `agent` ayarı | Davranış |
|---|---|
| `auto` (varsayılan) | Claude girişi ya da `ANTHROPIC_API_KEY` varsa Claude, yoksa Cursor |
| `claude` | Her zaman Claude |
| `cursor` | Her zaman Cursor |

Tek seferlik seçim için `flowloop run IDT-1234 --agent cursor` kullanılır. Hangisinin seçileceğini `flowloop check` gösterir; çalıştırma başında da ekrana yazılır.

Cursor CLI kurulumu:

```bash
curl https://cursor.com/install -fsS | bash
cursor-agent login
```

Cursor ile de aynı kurallar geçerlidir. Rol yetkileri yine kodla zorlanır: flowloop çalışma kopyasına geçici bir `.cursor/hooks.json` yazar ve Cursor her komuttan ve her dosya işleminden önce flowloop'a sorar. Hook çalışmazsa işlem engellenir. Hook'ların hiç çalışmadığı fark edilirse o rolün sonucu kabul edilmez. Çalıştırma bitince bu dosyalar silinir; projenin kendi `.cursor/` dosyaları olduğu gibi geri konur.

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
| `flowloop runs` | Bu projedeki çalıştırmaları ve durumlarını listeler |
| `flowloop resume <id> -v [--agent cursor]` | Yarım kalan bir çalıştırmayı baştan başlatmadan sürdürür (kontroller → reviewer → commit → push → Jira) |
| `flowloop task IDT-123` | Sadece Jira görevini dosyaya çeker (çalıştırmaz) |
| `flowloop clean` | Merge edilmiş çalıştırmaların çalışma klasörlerini siler |
| `flowloop clean --all` | Tüm çalıştırmaların çalışma klasörlerini siler |
| `flowloop init --force` | Ayar dosyasını yeniler; elle girdiğin değerleri korur |

Çalıştırma kimliği (`<id>`) `flowloop runs` çıktısında ve hata mesajında yazar.

## 7. Ayarlar (`.flowloop/flowloop.yaml`)

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

Reviewer'ın ve kontrollerin reddettiği konular `.flowloop/lessons.md` dosyasına yazılır. Developer ve reviewer bu dosyayı sonraki her işte görür ve aynı hataları tekrarlamamaya çalışır.

## kgflow'dan geçiş

Proje eskiden **kgflow** adıyla kullanıldıysa yapman gereken tek şey flowloop'u kurmak:

```bash
git clone https://github.com/yunusemre/flowloop.git ~/.flowloop/src && ~/.flowloop/src/install.sh
```

Gerisi kendiliğinden olur:

| Eski | Yeni | Nasıl |
|---|---|---|
| `kgflow` komutu | `flowloop` | `kgflow` bir süre daha çalışır ve uyarı verir |
| Projede `.kgflow/kgflow.yaml` | `.flowloop/flowloop.yaml` | İlk `flowloop` komutunda taşınır (görevler ve dersler dahil) |
| `.gitignore`'daki `.kgflow` satırı | `.flowloop/` | `flowloop init --force` günceller |
| Anahtar Zinciri'ndeki "kgflow" kayıtları | "flowloop" | İlk kullanımda okunup taşınır |
| `~/.kgflow/config.json`, `~/.kgflow/work` | `~/.flowloop/...` | Eskiler okunmaya devam eder; `flowloop runs` / `resume` eski çalıştırmaları da bulur |

## 8. Sorun giderme

| Belirti | Çözüm |
|---|---|
| `zsh: command not found: flowloop` | Kurulumu tekrar çalıştır, sonra yeni bir terminal aç |
| `Kurulum kaydı bulunamadı` (`flowloop update`) | flowloop eski yöntemle kurulmuş; kurulumu bir kez yeniden çalıştır |
| `Kaynağa erişilemedi` | Bitbucket SSH erişimini kontrol et: `ssh -T git@bitbucket.org` |
| `zsh: permission denied: flowloop` | `flowloop update` (yeniden derler) ya da kurulum klasöründe `npm run build` |
| npm yetki hatası (`EACCES`) | `FLOWLOOP_FORCE_NVM=1` ile kur (sudo'suz Node kurulumu) |
| `Jira yetki hatası (401)` / `Jira kimlik bilgisi yok` | `flowloop setup --force` ile token'ı yenile; kayda erişimin olmalı |
| `N turda onay alınamadı` | Son geri bildirim `flowloop runs` ile bulunan klasördeki `run.json` dosyasında. Kontroller düzeldiyse `flowloop resume <id> -v` |
| `YENİ lint hatası` sürekli çıkıyor | Projede Prettier ile ESLint kuralları çakışıyor olabilir. `.eslintrc`'de `extends` listesinin sonuna `'prettier'` ekle |
| `IDT-…-2` gibi branch açıldı | Aynı adlı eski branch'te commit var. Eskisini incele ya da sil |
| `Ne Claude ne Cursor erişimi bulundu` | `flowloop setup` |
| `Cursor hook'ları çalışmadı` | Cursor CLI eski olabilir: `cursor-agent update` |
| Cursor'da her yazma işlemi "yol belirtilmemiş" diye reddediliyor | Cursor'un hook formatı değişmiş olabilir; `run.json` içindeki `denials` listesine bak ve flowloop'u güncelle |
| Eski `.kgflow` / `.ekip` klasörü | İlk `flowloop` komutunda otomatik `.flowloop`'a taşınır |

## 9. Güvenlik

- Token'lar sistemin anahtar zincirinde saklanır; hiçbir proje dosyasına yazılmaz ve ajanlara geçmez.
- `.env` gibi dosyalar hiçbir rol tarafından okunamaz (`paths.readDeny`).
- Ajanlar senin çalışma klasörünü değiştirmez; ayrı bir kopyada çalışırlar.
- Force push, `--no-verify` ve `--amend` engellidir. Commit hook'ları çalışır.
- Jira metni görev tanımı olarak kullanılır; içindeki talimatlar flowloop'un kurallarını ve rol yetkilerini değiştiremez.
- Kod hafızası (MCP) sadece okuma araçlarıyla açılır.
- Merge her zaman PR üzerinden bir insan tarafından yapılır.
