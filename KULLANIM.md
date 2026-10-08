# flowloop Kullanım Kılavuzu

flowloop, bir Jira görevini dört rollü bir AI ekibine yaptırır ve sonucu push'lanmış bir branch, PR bağlantısı ve Jira yorumu olarak teslim eder. Merge her zaman insandadır.

```
Jira görevi ─► ANALİST ─► plan ─► DEVELOPER ─► otomatik kontroller ─► REVIEWER ─(PASS)─► SENİN ONAYIN ─► COMMITTER ─► push + Jira yorumu
                 ▲           │          ▲                                    │
                 └─ cevabın ─┘          └──────────── FAIL (geri bildirim) ◄─┘
               (açık sorular varsa)
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
| 3. Jira | Jira adresi, Atlassian e-postan ve API token | https://id.atlassian.com/manage-profile/security/api-tokens → **Create API token** | Jira'ya bağlanılır, adın gösterilir ("Jira doğrulandı: Ad Soyad") |
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

Jira adresi kodun içinde sabit değildir; `flowloop setup` Jira adımında sorar ve **adres girilmeden ilerlemez**. Tarayıcıda Jira'yı açtığında adres çubuğundaki adresi yazman yeterli (ör. `https://sirket.atlassian.net`). Kısa yazım (`sirket` ya da `sirket.atlassian.net`) ya da kopyalanmış bir kayıt bağlantısı da olur; tam adrese çevrilir. Adres `~/.flowloop/config.json` dosyasına kaydedilir ve bütün projelerde kullanılır.

Öncelik sırası:

1. Projenin `.flowloop/flowloop.yaml` dosyasındaki `jira.baseUrl` (o projeye özel adres)
2. `JIRA_BASE_URL` ortam değişkeni
3. `flowloop setup`'ta girilen adres

Değiştirmek için `flowloop setup --force`.

Adres bir kez girildikten sonra görevler sadece anahtarla çalıştırılır: `flowloop run PROJ-1234`. Tarayıcıdan kopyaladığın bağlantıyı yapıştırırsan da çalışır; anahtar bağlantıdan alınır.

## 4. Bir projeye eklemek (proje başına bir kez)

```bash
cd ~/projeler/my-app
flowloop init
flowloop check
git add .gitignore && git commit -m "chore: flowloop klasörünü gitignore'a ekle"
```

`flowloop init` şunları yapar:

- **Teknolojiyi algılar:** React Native/Expo, React, Next.js, Node, NestJS ya da .NET. Test, tip kontrolü, lint ve format komutlarını projenin kendi araçlarına göre seçer.
- **Base branch'i bulur:** production → main → master sırasıyla bakar.
- **Branch adı kalıbını belirler:** mevcut branch'ler Jira anahtarıyla başlıyorsa (`PROJ-123-...`) aynı kalıbı kullanır.
- **Kuralları bulur:** projedeki `CLAUDE.md`, `.cursorrules` gibi kural dosyalarını ve kişisel `~/.claude/CLAUDE.md` dosyanı otomatik dahil eder. Kod hafızası MCP'sini (claude-code-memory) de bulur.
- **Ayar dosyasını oluşturur:** `.flowloop/flowloop.yaml`.
- **`.gitignore`'ı günceller:** `.flowloop/` satırını ekler; dosya yoksa oluşturur.

`flowloop check` rollerin yetkilerini, komutları ve bulunan kural dosyalarını gösterir. Komutlarda bir sorun varsa `.flowloop/flowloop.yaml`'ı düzenle.

## 5. Günlük kullanım

```bash
cd ~/projeler/my-app
flowloop run PROJ-1234 --approve-plan -v
```

| Seçenek | Anlamı |
|---|---|
| `--approve-plan` | Analist planı yazdıktan sonra durur ve onay ister. **Önerilir.** |
| `-v` | Ajanların ne yaptığını canlı gösterir |
| `--refresh` | Görev dosyası daha önce çekildiyse bile Jira'dan yeniden çeker |
| `--no-push` | Bu seferlik push yapmaz |
| `--agent claude\|cursor` | Ajan aracını bu seferlik seç |
| `--dry-run` | Ajan çalıştırmadan prompt'ları ve yetkileri gösterir (ücretsiz) |
| `--skip-review` | İş bitince değişiklikleri sormadan commit/push eder (önerilmez) |
| `--epic`, `--branch`, `--approve-each-plan`, `--restart` | Birden fazla görev için (bkz. [Birbirine bağlı görevler](#birbirine-bağlı-görevler-toplu-çalışma)) |
| `--questions ask\|jira\|assume` | Analistin açık sorularında ne yapılacağı (bkz. [Açık sorular](#açık-sorular)); varsayılan `flowloop.yaml → questions` |

Akış:

1. **Görev:** Jira kaydı `.flowloop/tasks/PROJ-1234.md` dosyasına çekilir. Bu dosyayı düzenleyip tekrar çalıştırabilirsin; `--refresh` vermedikçe üzerine yazılmaz.
2. **Çalışma alanı:** base branch'ten temiz bir kopya (git worktree) açılır. Senin çalışma klasörüne hiç dokunulmaz.
3. **Plan:** analist planı yazar. Görevde ürün kararı gerektiren belirsizlik varsa planın **Açık sorular** bölümüne yazar; flowloop bunları sana sorar ve cevaplar plana işlenmeden geliştirmeye geçmez (bkz. [Açık sorular](#açık-sorular)). `--approve-plan` verdiysen planı okursun; onaylayabilir, yorum yazıp güncelletebilir ya da iptal edebilirsin (bkz. [Plan onayı](#plan-onayı)).
4. **Geliştirme döngüsü** (en fazla 3 tur):
   - Developer kodu yazar.
   - flowloop değişen dosyaları formatlar ve otomatik kontrolleri çalıştırır: bu işin testleri, **yeni** tip hataları, **yeni** lint hataları. Projede zaten var olan hatalar sayılmaz.
   - Kontroller geçerse reviewer inceler. FAIL verirse geri bildirimi developer'a döner ve yeni tur başlar.
5. **Senin onayın:** reviewer PASS verince iş **commit'lenmeden önce** sana gösterilir: değişen dosyalar, planın varsayımları ve **incelenmesi önerilenler** (reviewer'ın notları, developer'ın riskleri ve doğrulayamadıkları). Onaylayabilir, değişiklik isteyebilir ya da bekletebilirsin (bkz. [Değişiklik onayı](#değişiklik-onayı)).
6. **Teslim:** onay verince committer commit'ler. Branch push'lanır, PR bağlantısı verilir ve Jira kaydına özet yorum düşer; varsayımlar ve incelenmesi önerilenler yorumda ayrı başlıklarla yer alır.

Bittiğinde ekranda şunlar görünür:

```
── BİTTİ
  a1b2c3d feat(harita): görevdeki birden fazla gönderiyi ayrı işaretle göster

  Branch  : PROJ-1234-siparis-listesine-filtre-ekle
  Maliyet : $2.84 · 2 tur · 0 reddedilen işlem

  Push    : origin/PROJ-1234-siparis-listesine-filtre-ekle ✓
  PR aç   : https://bitbucket.org/sirket/my-app/pull-requests/new?source=...
  Jira    : https://sirket.atlassian.net/browse/PROJ-1234?focusedCommentId=...
```

Sonra PR'ı açıp normal kod incelemesini yaparsın.

### Birbirine bağlı görevler (toplu çalışma)

Birden fazla görev verirsen flowloop onları tek tek değil, birlikte ele alır:

```bash
flowloop run IDT-101 IDT-102 IDT-103 --approve-plan -v
flowloop run --epic IDT-100 --approve-plan -v      # epic'in bitmemiş alt işleri, Jira'daki sırayla
```

1. **Toplu plan:** analist bütün görevleri (epic verdiysen epic'in açıklamasıyla birlikte) ve kodu okur; planına şunları yazar:
   - **Sıra:** hangi görev önce (ör. önce API, sonra onu kullanan ekran).
   - **Bağımlılıklar:** görevler arasındaki bağımlılıklar ve aynı dosyayı değiştirecek görevler.
   - **Görev notları:** her görev için kısa notlar.
   - **Ortak riskler.**
   - **Açık sorular:** bütün görevlerin açık soruları tek listede, her biri ait olduğu görevle (`S-1 (IDT-102): …`).
2. **Sorular bir kez:** sorular tek seferde sorulur (bkz. [Açık sorular](#açık-sorular)); cevaplanmadan hiçbir görevin geliştirmesine geçilmez. **[j]** seçilirse her soru kendi Jira kaydına yazılır.
3. **Plan onayı:** `--approve-plan` verdiysen toplu planı onaylar ya da yorumla güncelletirsin (sırayı değiştirmek dahil).
4. **Görevler sırayla, tek branch'te:** her görev kendi akışıyla yürür (analist → developer ⇄ reviewer → senin onayın → committer) ve **bir öncekinin commit'lerinin üzerinden** başlar.
   - Her görevin ajanları şunları görür: toplu planı, cevaplarını ve önceki görevlerin commit'leri ile özetlerini.
   - "Sadece yeni hatalar" kuralı her görevde bir önceki görevin bıraktığı noktaya göre uygulanır.
   - Her görevin kendi commit'leri ve kendi Jira yorumu olur; yorumda "Toplu çalışma 2/3" satırı yer alır.
   - Branch her görevden sonra push'lanır; tek PR açarsın.
5. **Durursa kaldığı yerden:** bir görev durursa (reviewer onay vermedi, kapsam talebi reddedildi, bütçe…) toplu çalışma da durur. Aynı komutu tekrar çalıştırınca toplu plan yeniden yapılmaz ve tamamlanan görevler atlanır; duran görev baştan denenir.
   - Duran görevin yarım denemesi branch'e commit eklediyse bu commit'ler `flowloop-arsiv/...` branch'ine alınır ve branch görevin başladığı noktaya döner.
   - Görev commit onayında kaldıysa önce `flowloop resume <id>` ile tamamlarsın, sonra aynı komutla devam edersin.
   - Baştan başlamak için `--restart` verirsin.

| Seçenek | Anlamı |
|---|---|
| `--epic IDT-100` | Görevleri epic'in bitmemiş alt işlerinden al (Jira sırasıyla); ek anahtarlar da yazılabilir |
| `--branch <ad>` | Toplu çalışmanın branch adı (varsayılan: ilk görevden, `branchName` kalıbıyla) |
| `--approve-plan` | Toplu planı onaya sun (her görevin planı ayrıca sorulmaz) |
| `--approve-each-plan` | Her görevin kendi planını da onaya sun |
| `--restart` | Yarım kalan aynı toplu çalışmayı sürdürme, baştan başla |
| `--skip-review` | Görevlerin commit onayını sorma (başında olmayacaksan; önerilmez) |

Etkileşimli terminalde her görevin sonunda değişiklikler commit'ten önce sana sorulur. Başında olmayacaksan iki ayar yeterli: `--questions jira` sorularda Jira'ya yazıp durur, `--skip-review` commit onayını atlar. Merge yine PR'da insanla yapılır.

Toplu çalışmalar `flowloop runs` listesinin başında görünür (`batch-...`, kaç görevin bittiği ve branch). Kayıt: `~/.flowloop/work/<repo>/batch-.../batch.json`, toplu plan: `run/plan.md`.

### Açık sorular

Analist görevdeki belirsizlikleri ikiye ayırır:

- **Varsayım:** kodu okuyarak ya da projenin mevcut davranışından makul biçimde çözebildiği noktalar. Planda ilgili kabul kriterinin altına `Varsayım: ...` diye yazılır, sana sorulmaz; ama onay ekranında ve Jira yorumunda listelenir.
- **Açık soru:** yanlış varsayılırsa işi boşa çıkaracak ya da ürün kararı gerektiren noktalar (iş kuralı, kullanıcıya görünen metin ya da davranış, veri/sözleşme değişikliği, kapsamın sınırı). Planın `## Açık sorular` bölümüne en fazla 5 soru yazılır; her birinde neden önemli olduğu ve **cevap gelmezse** önerilen varsayılan bulunur.

Açık soru varsa flowloop geliştirmeye geçmeden durur:

```
━━ AÇIK SORULAR — geliştirmeye geçmeden önce cevabın gerekiyor ━━

S-1  Ekspres ücreti KDV dahil mi?
      Neden önemli: sepette fiyat yanlış görünür
      Cevap gelmezse: KDV dahil

Ne yapalım?
  [c] Cevapla — sorular sırayla sorulur; boş bırakırsan analistin önerdiği varsayılan kullanılır
  [v] Varsayılanlarla devam et — Jira yorumunda "Varsayımlar" olarak listelenir
  [j] Soruları Jira'ya yorum olarak yaz ve dur — cevaplar gelince: flowloop run <KEY> --refresh
  [h] Durdur — plan saklanır
```

- **[c] Cevapla:** cevapların analiste gider; analist planı (kabul kriterleri, test planı, riskler) günceller ve cevaplanan soruları bölümden çıkarır. Cevaplar görev metnine de eklenir; developer ve reviewer da görür. Cevaplar yeni soru doğurursa tekrar sorulur (en fazla 3 tur; sonra kalanlar varsayılanla geçilir). Sonra `--approve-plan` verdiysen güncel plan onayına gelir.
- **[j] Jira'ya yaz:** cevabı ürün sahibi verecekse sorular Jira kaydına yorum olarak yazılır ve çalıştırma durur. Cevaplar Jira'ya yazılınca `flowloop run PROJ-1234 --refresh` görevi (son yorumlarla birlikte) yeniden çeker; görev değiştiği için analiz baştan yapılır.
- **[v] Varsayılanla devam:** sorular cevaplanmadan geçilir; önerilen varsayılanlar onay ekranında ve Jira yorumunda "Varsayımlar" başlığıyla görünür.

Etkileşimsiz çalıştırmada (CI, zamanlanmış iş) ne olacağını `flowloop.yaml → questions` belirler; `--questions` ile bu seferlik ezilir:

| Değer | Etkileşimli terminal | Etkileşimsiz çalıştırma |
|---|---|---|
| `ask` (varsayılan) | Sorar | Durur; sorular `run/questions.md` dosyasında |
| `jira` | Sorar (Jira seçeneği de var) | Soruları Jira'ya yazar ve durur |
| `assume` | Sormaz, varsayılanla devam eder | Varsayılanla devam eder |

Sorular ve cevaplar `run.json` (`questions`) ve `run/answers.md` içinde durur; `flowloop stats` kaç soru sorulduğunu ve kaçının cevaplandığını gösterir.

### Plan onayı

`--approve-plan` ile çalıştırdığında analist planı yazınca şu soru gelir:

```
Plan uygun mu?
  [e] Onayla, geliştirmeye geç
  [y] Yorum yaz — analist yorumunu değerlendirip planı güncellesin
  [h] İptal (plan saklanır; görevi yeniden çalıştırınca bu plandan devam edilir)
```

- **[y] Yorum:** istediğin kadar satır yazabilirsin, bitirmek için boş bir satırda Enter'a basarsın. Analist yorumunu ve mevcut planı birlikte değerlendirir, planı günceller ve neyi değiştirdiğini özetler. Katılmadığı ya da uygulanamayan bir nokta varsa (ör. developer'ın değiştiremeyeceği bir dosya) planı değiştirmez, "Geri bildirime yanıt" başlığıyla nedenini yazar. Güncel plan tekrar sana sorulur. Önceki turların yorumları da analiste hatırlatılır; en fazla 5 tur yenilenebilir.
- **[h] İptal:** analiz boşa gitmez. Plan saklanır; aynı görevi tekrar `flowloop run PROJ-1234 --approve-plan` ile çalıştırdığında analist yeniden çalışmaz, aynı plan karşına gelir. O zaman ek olarak **[b] Bu planı kullanma, baştan analiz et** seçeneği de çıkar.
- Verdiğin yorumlar çalıştırma kaydında (`run.json` → `planFeedback`) ve `run/plan-feedback.md` dosyasında durur.

### Değişiklik onayı

Reviewer işi onayladıktan sonra hiçbir şey commit'lenmeden, push'lanmadan ve Jira'ya yazılmadan önce şunu görürsün:

```
━━ İŞ TAMAMLANDI — commit'ten önce senin onayın gerekiyor ━━
Reviewer: (değerlendirmenin özeti)

Varsayımlar (doğru değilse değişiklik iste):
  - Liste 20'şerli sayfalanır
  - S-2 cevaplanmadı (hafta sonu ekspres var mı?) → yok

İncelenmesi önerilenler:
  - Sepette ekspres seçilince toplamın güncellendiğini cihazda dene
  - [doğrulanmadı] Android'de klavye açıkken buton görünürlüğü
  - [risk] fiyat API'sini kullanan web ekranı etkilenebilir

Projede önceden var olan sorunlar (bu işte dokunulmadı):
  - src/utils/date.ts: kullanılmayan import

Değişen dosyalar:
 src/screens/Map/MapScreen.tsx      | 42 +++++++++----
 src/screens/Map/MapScreen.test.tsx | 88 ++++++++++++++++++++++++

Kodu editöründe de açabilirsin: ~/.flowloop/work/my-app/<çalıştırma>/wt

Değişiklikler uygun mu?
  [e] Onayla — commit, push ve Jira yorumu
  [d] Farkın tamamını göster
  [y] Değişiklik iste — yorumun developer'a gider, testler ve reviewer tekrar çalışır
  [h] Şimdilik onaylama — commit yapılmaz, sonra: flowloop resume
```

- **Varsayımlar:** planın `Varsayım:` satırları ve cevaplanmadan geçilen sorular. Biri yanlışsa **[y]** ile düzelttir.
- **İncelenmesi önerilenler:** reviewer PASS verse bile bir insanın bakması gereken noktalar (cihazda elle deneme, testle doğrulanamayan davranış, geriye dönük uyumluluk, performans, güvenlik, başka ekipleri etkileyen değişiklik) ve developer'ın Handoff'undaki riskler ile doğrulayamadıkları. Aynı liste bitiş ekranında ve Jira yorumunda da yer alır.
- **Önceden var olan sorunlar:** developer'ın gördüğü ama bu işin kapsamı dışında olduğu için dokunmadığı sorunlar; ayrı bir görev açmak için.
- **[d] Fark:** bütün değişiklikler satır satır gösterilir (yeni dosyalar dahil). Gösterilen yol editörde de açılabilir.
- **[y] Değişiklik iste:** birden fazla satır yazabilirsin, bitirmek için boş satırda Enter. Yorumun developer'a öncelikli istek olarak gider; developer mevcut çalışmanın üzerine uygular, otomatik kontroller çalışır ve reviewer isteğinin karşılanıp karşılanmadığını da kontrol eder. Sonuç sana tekrar sorulur. Önceki isteklerin de hatırlatılır.
- **[h] Şimdilik onaylama:** commit yapılmaz, çalışma alanı olduğu gibi kalır. İncelemeyi bitirince `flowloop resume <id>` aynı soruyu tekrar sorar ve onay verirsen commit/push/Jira yapılır. (Sürdürmede değişiklik isteği yoktur; o durumda isteği görev dosyasına ekleyip görevi yeniden çalıştır.)
- Değişiklik isteklerin `run.json` (`changeRequests`) ve `run/change-requests.md` içinde durur.

Soru sadece etkileşimli bir terminalde sorulur. Sormadan commit'lemek için `--skip-review` verilir.

### Jira'ya düşen yorum

- **Committer'ın yazdığı kısım:** Sorun, Yapılan, Neden bu yaklaşım, Nasıl test edildi.
- **flowloop'un eklediği kısım:** varsayımlar, incelenmesi önerilenler, projede önceden var olan sorunlar (varsa), branch, commit'ler, PR bağlantısı.
- **İmza:** "Claude ile hazırlandı", kullanılan modeller ve işi başlatan kişi. Commit'lerdeki `Co-Authored-By: Claude` satırı da işi kimin yaptığını gösterir.

## Birbirine bağımlı projeler

Bir projede çalışırken başka bir repoya da bakmak ya da onu da değiştirmek gerekebilir (ör. bir job üzerinde çalışırken backend'deki API'yi değiştirmek). Bu repoları projenin `.flowloop/flowloop.yaml` dosyasına `related` olarak eklersin:

```yaml
related:
  - name: backend
    path: ../backend          # bilgisayardaki yol; bu projeye göre göreli ya da ~/... olabilir
    edit: ["**"]              # developer'ın değiştirebileceği yollar ("**" = bütün repo; ör. "src/**" ile daralt)
  - name: shared-models
    path: ~/projeler/shared-models
                              # edit yok → sadece okunur
```

İstediğin kadar repo ekleyebilirsin. `path` git reposu olmayan bir klasör de olabilir (ör. ortak modeller, şemalar, dokümanlar). Böyle bir klasör **sadece okunur** eklenebilir: kopyası açılmaz, olduğu yerden okunur, branch ya da commit oluşmaz; `edit` verilirse `flowloop check` hata verir.

Git reposu olan her biri için:

- **Temiz kopya:** kendi base branch'inden (o reponun `flowloop.yaml`'ı ya da production → main → master) ayrı bir çalışma kopyası açılır. Bilgisayarındaki repoya dokunulmaz.
- **Okuma:** analist, developer, reviewer ve committer hepsini okuyabilir. O reponun `.env` gibi gizli dosyaları (kendi `readDeny` listesi) okunamaz. O reponun `CLAUDE.md` gibi kural dosyaları da ajanlara verilir.
- **Yazma:** developer sadece `edit` altındaki yollara yazabilir; dışına yazarsa iş durdurulur. `edit` verilmemiş repo sadece okunur.
- **Kontroller:** değişen dosyalar için o reponun kendi komutlarıyla format, testler, yeni tip ve lint hataları çalıştırılır. Komutlar o reponun `.flowloop/flowloop.yaml`'ından, yoksa otomatik tespitten gelir. Ajanlar ilgili repoda komut çalıştıramaz; bunu flowloop yapar.
- **Onay:** reviewer ve sen ([Değişiklik onayı](#değişiklik-onayı)) bütün repoların farkını birlikte görürsünüz.
- **Teslim:** değişiklik olan her repoda aynı adla branch açılır (`PROJ-1234-...`). Commit mesajını committer yazar, commit'i flowloop atar (commit hook'ları çalışır, içerik onaylananla aynı olmalı). Her repo ayrı push'lanır ve ayrı PR bağlantısı verilir. Jira yorumunda hepsinin branch'i, commit'leri ve PR bağlantısı yazar.
- **Sadece ilgili repo değişirse:** ana projede branch bırakılmaz; sadece değişen repo teslim edilir.

Mutasyon testi sadece ana projede yapılır. `flowloop check` eklenen repoları, yollarını ve hangi test komutunun kullanılacağını gösterir.

### Görev başına kapsam

`flowloop.yaml`'daki `edit` bir **tavandır**: o repoya en fazla bu yollarda yazılabilir. Her görev bu tavanın tamamına ihtiyaç duymaz; mobilde bir metin değişikliği backend'e yazma yetkisi gerektirmez. Bu yüzden analist planına şu bölümü ekler:

```markdown
## Repo kapsamı
- backend: yazılabilir
- shared-models: salt okunur
```

- Plan onayında (`--approve-plan`) kapsam planın altında ayrıca gösterilir; planı onaylarken kapsamı da onaylamış olursun. Daraltmak ya da genişletmek için planı yorumla güncellet.
- Plan tavanı sadece **daraltabilir**. `edit` verilmemiş bir repoyu plan yazılabilir yapamaz; denenirse uyarı verilir ve repo salt okunur kalır.
- Listede olmayan ya da okunamayan satırlar salt okunur sayılır.
- Bölüm hiç yoksa (ör. önceki bir sürümle yazılmış plan) **bütün ilgili repolar salt okunur** sayılır ve uyarı verilir. Yazma gerekiyorsa plan onayında yorum yazarak planı güncelletebilirsin (ör. "backend yazılabilir olsun"); geliştirme sırasında gerekirse developer kapsam talebi yazar.
- Planda ayrıca **Repolar arası sözleşme** bölümü bulunur: API uç noktaları, alanlar ve paylaşılan tiplerde ne değiştiği, hangi tarafın önce değişeceği. Reviewer iki tarafın birbiriyle uyumunu bu bölüme göre kontrol eder.

### Kapsam talebi

Geliştirme sırasında developer kapsam dışında bir değişikliğin gerektiğini fark ederse (salt okunur bir repo ya da izinli olmayan bir yol), o dosyayı değiştirmeye ya da etrafından dolaşan bir çözüm yazmaya çalışmaz; ne değişmesi gerektiğini ve nedenini bir kapsam talebi olarak yazar. flowloop döngüyü durdurur ve sana sorar:

- **[g] Kapsamı genişlet:** `flowloop.yaml`'ın izin verdiği ama bu görevde kapalı olan repolar yazılabilir olur. Tavanın dışına çıkılamaz; onu değiştirmek `flowloop.yaml`'ı düzenlemek demektir.
- **[d] Genişletmeden devam et:** developer mevcut kapsamda kalır ve yapamadığı kısmı özetinde belirtir.
- **[h] Durdur:** bu değişiklik için ayrı bir görev açarsın.

Kapsam kararı bir geliştirme turu sayılmaz; bir çalıştırmada en fazla 3 talep değerlendirilir (daha fazlası görevin bölünmesi gerektiğine işarettir). Etkileşimsiz çalıştırmada talep gelirse çalıştırma durur; yetki hiçbir zaman ajanın isteğiyle kendiliğinden açılmaz. Talepler ve verilen kararlar `run/scope-requests.md` ve `run.json` içinde saklanır.

## Claude yerine Cursor

Claude erişimi yoksa flowloop ajanları **Cursor CLI** ile çalıştırır. Seçim otomatiktir:

| `agent` ayarı | Davranış |
|---|---|
| `auto` (varsayılan) | Claude girişi ya da `ANTHROPIC_API_KEY` varsa Claude, yoksa Cursor |
| `claude` | Her zaman Claude |
| `cursor` | Her zaman Cursor |

Tek seferlik seçim için `flowloop run PROJ-1234 --agent cursor` kullanılır. Hangisinin seçileceğini `flowloop check` gösterir; çalıştırma başında da ekrana yazılır.

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
| `flowloop stats [--since 30d] [--json]` | Çalıştırmaların ölçüm özeti (aşağıya bak) |
| `flowloop resume <id> -v [--agent cursor]` | Yarım kalan bir çalıştırmayı baştan başlatmadan sürdürür (kontroller → reviewer → commit → push → Jira) |
| `flowloop task PROJ-123` | Sadece Jira görevini dosyaya çeker (çalıştırmaz) |
| `flowloop clean` | Merge edilmiş çalıştırmaların çalışma klasörlerini siler |
| `flowloop clean --all` | Tüm çalıştırmaların çalışma klasörlerini siler |
| `flowloop init --force` | Ayar dosyasını yeniler; elle girdiğin değerleri korur |

Çalıştırma kimliği (`<id>`) `flowloop runs` çıktısında ve hata mesajında yazar.

### Ölçüm (`flowloop stats`)

Her çalıştırma bittiğinde (başarılı ya da başarısız) özeti `.flowloop/history.jsonl` dosyasına eklenir. Bu dosya git'te yerel olarak yok sayılır ve `flowloop clean` ile silinmez; çalışma klasörleri temizlense de geçmiş kalır. `flowloop stats` bu geçmişi ve henüz temizlenmemiş çalıştırmaları birlikte okur:

- **Kalite:** başarı oranı, ilk incelemede PASS oranı, reviewer FAIL oranı, otomatik kontrol hatası oranı, ortalama tur.
- **İnsan müdahalesi:** plan yorumu ve değişiklik isteği ortalaması, kapsam talepleri ve verilen kararlar.
- **Yönetişim:** kapsamı plandan gelen ve birden fazla repoya dokunan çalıştırmalar, reddedilen işlemler (en sık rol ve araç).
- **Başarısızlık nedenleri, maliyet ve süre.** Cursor maliyet bildirmediği için maliyet ortalamasına sadece Claude çalıştırmaları girer. Süre onay bekleme süresini de içerir.

`--since 30d` (ya da `2w`, `6m`) dönemi daraltır; `--json` çıktıyı başka bir araca ya da rapora aktarmak içindir. Süre ve kontrol oranları bu sürümden önceki kayıtlarda bulunmaz.

## 7. Ayarlar (`.flowloop/flowloop.yaml`)

En çok değiştirilenler:

| Alan | Açıklama |
|---|---|
| `baseBranch` | Boşsa production → main → master |
| `branchName` | `{{jira}}-{{slug}}` → `PROJ-1234-siparis-listesine...` |
| `push` | İş bitince branch'i push'la (force push asla yapılmaz) |
| `jira.comment` | İş bitince Jira'ya yorum ekle |
| `questions` | Analistin açık soruları: `ask` (terminalde sor, etkileşimsizse dur), `jira` (etkileşimsizse Jira'ya yaz ve dur), `assume` (varsayılanla devam). Bkz. [Açık sorular](#açık-sorular) |
| `commands.testRelated` | Bu işin testleri, ör. `npx jest --findRelatedTests {{files}} --passWithNoTests` |
| `commands.typecheck` | Ör. `npx tsc --noEmit -p .`; sadece yeni hatalar sayılır |
| `commands.lint` | Ör. `npx eslint --quiet {{files}}`; sadece yeni **hatalar** sayılır, uyarılar bloklamaz |
| `commands.format` | Ör. `npx prettier --write {{files}}`; her turdan sonra otomatik çalışır |
| `paths.edit` | Developer'ın değiştirebileceği yollar. Varsayılan `**` (bütün repo); gizli dosyalara (`readDeny`), `.git`'e ve `.flowloop`'a yine yazılamaz. Daraltmak için ör. `src/**` |
| `paths.readDeny` | Hiçbir rolün okuyamayacağı dosyalar (`.env` gibi) |
| `budgets` | Rol başına (`analist`, `gelistir`, `commit`) ve toplam (`total`) dolar limiti; tutarlar SDK'nın tahminidir. Dolunca etkileşimli terminalde ek bütçe sorulur |
| `maxIterations` | Developer ⇄ reviewer tur sayısı (varsayılan 3) |
| `agent` | `auto` / `claude` / `cursor` |
| `cursor.model` / `cursor.timeoutMin` | Cursor modeli / rol başına süre sınırı |
| `related` | Bağımlı repolar: `name`, `path`, `edit` (bkz. [Birbirine bağımlı projeler](#birbirine-bağımlı-projeler)) |

`{{files}}` yerine bu işte değişen dosyalar yazılır; testler, lint ve format sadece onlarda çalışır.

### Rol kuralları (system prompt)

Her rol iki parçayla çalışır:

- **System prompt:** rolün kalıcı davranış kuralları. `templates/rulesets/<rol>.md` dosyasındaki metin, Claude Agent SDK'da `claude_code` preset'inin sonuna (`append`) eklenir. Şu an `developer` için bir kural seti var (Ponytail'in kural setinden uyarlandı; lisans: `THIRD_PARTY_NOTICES.md`). Kural seti olmayan rollerde bu kısım boştur.
- **Kullanıcı mesajı:** önce görev (Jira anahtarı + görev metni), sonra o çalıştırmaya özel talimatlar (plan dosyası, izinli yollar, reviewer'ın geri bildirimi).

Kurallar metin olarak pakete dahildir: çalışma zamanında dış bağımlılık, hook ya da paylaşılan durum yoktur; aynı anda çalışan işler birbirini etkilemez.

Bir projede farklı kural istersen `.flowloop/rulesets/<rol>.md` dosyası oluştur (`developer`, `analist`, `reviewer`, `committer`); yerleşik olanın yerine o kullanılır. Dosyanın başındaki `<!-- ... -->` yorumları (atıf/not) ajana gönderilmez. Cursor CLI'de ayrı system prompt olmadığı için kurallar mesajın başına konur.

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
| `... için ayrılan bütçe doldu` / `reached maximum budget` | Etkileşimli terminalde flowloop ek bütçe sorar; `[e]` ile ajan kaldığı yerden devam eder. Kalıcı olarak artırmak için `.flowloop/flowloop.yaml` → `budgets` (ör. `analist: 2`, `total: 10`). Büyük projelerde ve `related` ile birden fazla repo okunurken analist daha çok harcar |
| `N turda onay alınamadı` | Son geri bildirim `flowloop runs` ile bulunan klasördeki `run.json` dosyasında. Kontroller düzeldiyse `flowloop resume <id> -v` |
| `YENİ lint hatası` sürekli çıkıyor | Projede Prettier ile ESLint kuralları çakışıyor olabilir. `.eslintrc`'de `extends` listesinin sonuna `'prettier'` ekle |
| `PROJ-…-2` gibi branch açıldı | Aynı adlı eski branch'te commit var. Eskisini incele ya da sil |
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
- İlgili repolarda yazma yetkisi görev başına daraltılır; ajan kendine yetki veremez, kapsam ancak senin onayınla ve `flowloop.yaml` sınırları içinde genişler.
