# Değişiklik günlüğü

Sürümler [Semantic Versioning](https://semver.org/lang/tr/) kuralına göre numaralanır: `MAJOR.MINOR.PATCH`.

- **PATCH** (1.0.x): hata düzeltmesi; ayar dosyasında değişiklik gerekmez.
- **MINOR** (1.x.0): yeni özellik; mevcut ayarlar ve komutlar aynen çalışır.
- **MAJOR** (x.0.0): uyumsuz değişiklik; gerekenler burada yazılır (çoğunlukla `kgflow init --force` yeterlidir).

## 1.8.0 — 2026-10-13

### Yeni
- **Karar gerekli:** reviewer görev metni, plan, kullanıcının cevapları ve referanslar (ör. başka bir branch) arasında çelişki bulursa taraf seçmiyor, developer'a da seçtirmiyor. `## Karar gerekli` bölümü yazıyor; flowloop durup sana soruyor. Kararın developer'a bağlayıcı talimat olarak gidiyor ve görev metnine "Kullanıcı kararları" olarak ekleniyor, böylece sonraki turlarda yeniden açılmıyor. Etkileşimsiz çalıştırmada flowloop duruyor; `flowloop resume` önce kararı soruyor.
- **`resume`'da değişiklik isteği:** onay ekranında **[y] Değişiklik iste** artık sürdürmede de var. İsteğin developer'a gidiyor; kontroller ve reviewer (isteğin karşılandığını da kontrol ederek) tekrar çalışıyor.

### Değişen
- **Reviewer hedefi her turda değiştirmiyor.** Her inceleme turunda reviewer'a önceki raporu veriliyor. Önceki turda onayladığı ve bu turdaki değişikliğin etkilemediği maddeleri yeniden açmıyor; yeni FAIL nedeni sadece bu turdaki değişiklikten gelebiliyor (güvenlik açığı ya da veri kaybı gibi engelleyici sorunlar hariç).
- **Onaydan sonra değişen içerik sadece farkıyla inceleniyor.** Örneğin commit hook'u biçimlendirdiğinde `resume`, reviewer'a önceki onay raporunu ve sadece farkı veriyor. Fark yalnızca biçimse reviewer tekrar inceleme ve mutasyon yapmıyor.
- **Mutasyon kapsamı daraldı.** Mutasyon sadece davranış mantığı olan AK'lere uygulanıyor. Silme, ayar, yeniden adlandırma ve kod temizliği derleme ve arama ile doğrulanıyor. Bir şeyin yokluğunu test eden testler (reflection ile "sınıf yok", ayar dosyasında "anahtar yok") artık planlanmıyor, yazılmıyor ve reviewer tarafından istenmiyor.

## 1.7.1 — 2026-10-13

### Düzeltme
- **Commit hook'u biçimlendirince iş kayboluyordu.** Commit hook'u (ör. Husky.Net ile CSharpier) dosyaları yeniden biçimlendirince commit "onaylananla AYNI DEĞİL" hatasıyla duruyordu ve `resume` de devam edemiyordu. Artık:
  - hata mesajı farklı dosyaları ve çözümü gösteriyor;
  - `resume` güncel içeriği kontrollerden ve reviewer'dan yeniden geçirip onayı tekrar soruyor.
- **.NET'te CSharpier algılanıyor.** `dotnet-tools.json` ya da Husky.Net görevlerinde CSharpier varsa:
  - format adımı hook ile aynı formatter'ı kullanıyor: `dotnet csharpier format`;
  - lint sadece stil kurallarına bakıyor: `dotnet format style`.
- **Kopyalarda git hook'u kurulmuyor.** Kontrol ve kurulum komutları `HUSKY=0` ile çalışıyor. Önceden mutasyon kopyası git reposu olmadığı için `dotnet husky install` derlemeyi kırıyordu.

### Yeni
- **Uzantıya göre dosya listesi:** `{{files:cs,csproj}}` yer tutucusu sadece bu uzantılardaki değişen dosyaları verir. Eşleşen dosya yoksa format adımı atlanır.

## 1.7.0 — 2026-10-13

### Yeni
- **`resume` reviewer FAIL'inden sonra developer'la devam ediyor.** Önceden reviewer reddedince sürdürme duruyordu ve görevi baştan çalıştırmak (analizi tekrar ödemek) gerekiyordu. Artık son reviewer geri bildirimi developer'a gidiyor; kontroller ve reviewer tur sınırı içinde yeniden çalışıyor. Geri bildirim `run.json`'da (`lastReviewFeedback`) saklanıyor.
- **Dosya silme:** developer bir dosyayı silmek için içeriğini tamamen boşaltıyor. Base'de dolu olup 0 bayt kalan izlenen dosyaları flowloop siliyor. Önceden silinmesi gereken dosyalar boş olarak kalıyordu.

### Düzeltme
- **Mutasyon kopyası derlenmiyordu.** Bağımlılık klasörü bağlanamayan projelerde (ör. .NET) kopyada kurulum komutu bir kez çalışıyor. Sonraki sıfırlamalarda sadece kaynak dosyalar yenileniyor; kurulum çıktıları (`obj/`) korunuyor.
- **Ajanlar farklı araç sürümü görüyordu.** Ajanların Bash aracı artık flowloop'un kontrolleriyle aynı PATH'i (giriş kabuğu) kullanıyor. Önceden ajan .NET 8'i, kontroller .NET 10'u bulabiliyordu.
- **Claude Code'un uzun araç çıktıları okunamıyordu.** Claude Code bu çıktıları `~/.claude/projects/<çalışma kopyası>/<oturum>/tool-results/` altına yazıp ajana oradan okutuyor. Bu klasörü okumak gereksiz yere reddediliyordu; artık sadece o çalışma kopyasının oturumları için izin veriliyor.
- **.NET format adımı fazla geniş.** Varsayılan `dotnet format whitespace` oldu; stil düzeltmeleri (ör. file-scoped namespace) dosyanın tamamını değiştirip PR'ı şişiriyordu. Mevcut projelerde `commands.format` elle güncellenmeli.
- **Gizli dosyalar (readDeny):** analist bu dosyaları developer'ın işine koymuyor, developer denemiyor, reviewer bunlar için FAIL vermiyor. Gereken değişiklik "elle yapılmalı" notuyla "İncelenmesi önerilenler"e yazılıyor.

## 1.6.2 — 2026-10-13

### Düzeltme
- **Tip kontrolü uyarıları hata sayıyordu.** Artık sadece hata satırları sayılıyor (`error CS0103:`, `error TS2322:` gibi). NuGet güvenlik uyarıları ve ağa göre değişen `NU1900` uyarısı gibi uyarılar bloklamıyor.
- **Base kopya kurulmuyordu.** `linkDirs` boşken (ör. .NET) kurulum komutu sadece çalışma kopyasında çalışıyordu. Base kopya derlenemediği için oradaki her uyarı ve test hatası "yeni" görünüyordu; artık base kopyada da kurulum yapılıyor.
- **Ortam hatası developer'a gidiyordu.** Testler ortam yüzünden çalışmazsa (ör. Docker kapalı, Testcontainers) bu artık developer'a gönderilip tur harcanmıyor. Çalıştırma nedenini söyleyerek duruyor; ortam düzeltilince `flowloop resume <id>` ile kaldığı yerden devam ediliyor.

## 1.6.1 — 2026-10-13

### Düzeltme
- **.NET: birden fazla solution.** Kökte birden fazla `.sln` varsa `dotnet restore` hangisini kullanacağını bilemeyip hata veriyordu. `flowloop init` artık solution'ı kendisi seçiyor: .NET Framework projesi içermeyen, CI dosyalarında adı geçen ve en çok projeli olanı. Seçilen solution komutlara yazılıyor.
- **Kurulum hatası mesajı boştu.** dotnet ve npm gibi araçlar hatayı stdout'a yazdığı için mesaj boş çıkıyordu; artık çıktının sonu ve çıkış kodu gösteriliyor.

### Yeni
- **.NET testleri:** `{{testProject}}` ve `{{testFilter}}` yer tutucuları eklendi. Komut, değişen her test dosyasının projesinde ayrı çalışıyor ve sadece o test sınıflarını çalıştırıyor. Yeni .NET projelerinde varsayılan komut: `dotnet test {{testProject}} --no-restore --filter "{{testFilter}}"`. `{{testProjects}}` bütün test projelerini tek seferde verir.
- **.NET Framework projeleri** (eski biçim, `TargetFrameworkVersion`) algılanıyor. Bunlar Windows dışında derlenemediği için testleri "çalıştırılamadı (CI'da doğrulanmalı)" olarak atlanıyor ve bu durum reviewer'a bildiriliyor.

## 1.6.0 — 2026-10-09

### Yeni
- **Açık sorular:** analist belirsizlikleri "Varsayım" (koddan ya da makul biçimde çözülebilen) ve "Açık soru" (ürün kararı gerektiren) olarak ayırır. Planda `## Açık sorular` varsa flowloop geliştirmeye geçmeden durur: cevapla (analist planı günceller, cevaplar developer ve reviewer'a da gider), varsayılanlarla devam et, soruları Jira'ya yorum olarak yaz ve dur ya da durdur. Etkileşimsiz çalıştırmalar için `questions: ask | jira | assume` ayarı ve `--questions` bayrağı. Sorular ve cevaplar `run.json` ve `run/answers.md`'de; `flowloop stats` da gösterir.
- **Birbirine bağlı görevler (toplu çalışma):** `flowloop run IDT-1 IDT-2 …` ya da `flowloop run --epic IDT-100`. Analist önce bütün görevleri birlikte okuyup toplu plan yazar: sıra, bağımlılıklar, görev notları, ortak riskler ve bütün açık sorular tek listede (sorular bir kez sorulur; Jira'ya yazılırsa her soru kendi kaydına gider). Sonra görevler planlanan sırayla, aynı branch'te yürütülür: her görev öncekinin commit'lerinin üzerinden başlar, toplu planı, cevapları ve tamamlanan görevlerin özetlerini görür; her birinin kendi commit'leri ve Jira yorumu olur, tek PR açılır. Bir görev durursa aynı komut toplu planı tekrarlamadan ve tamamlananları atlayarak devam eder; yarım denemenin commit'leri `flowloop-arsiv/...` branch'ine alınır. Seçenekler: `--branch`, `--approve-each-plan`, `--restart`. Epic'in alt işleri Jira'daki sırasıyla, bitmemişler alınır.
- **İncelenmesi önerilenler:** reviewer PASS verse bile insanın bakması gereken noktaları ayrı bir bölüme yazar. Bunlar, developer'ın Handoff'undaki riskler ve doğrulayamadıkları, plandaki varsayımlar ve projede önceden var olan sorunlarla birlikte commit onay ekranında, bitiş özetinde ve Jira yorumunda listelenir.

### Değişen
- Görev metni değiştiyse (ör. Jira'dan `--refresh` ile cevaplarla yeniden çekildi) önceki çalıştırmanın planı devralınmaz; analiz baştan yapılır.
- Bilinmeyen bir komut satırı seçeneği artık hata yığını yerine kısa bir mesajla bildirilir.
- `flowloop init` şablonuna `questions: ask` satırı eklendi; mevcut projelerde ayar yoksa varsayılan `ask` kullanılır (değişiklik gerekmez).

## 1.5.0 — 2026-10-08

### Yeni
- **Rol kural setleri:** rolün kalıcı kuralları system prompt'a (Agent SDK: `claude_code` preset + `append`), görev (Jira anahtarı + metin) kullanıcı mesajına gider. Developer için Ponytail'den (MIT, v5.1.0) uyarlanan kural seti eklendi: en küçük tam değişiklik, kapsam ve kırılma kontrolü, sabit biçimli `## Handoff` son mesajı. Projeye özel kurallar `.flowloop/rulesets/<rol>.md` ile verilir. Lisans: `THIRD_PARTY_NOTICES.md`.

### Düzeltme
- İlgili repolarda (ve ana repoda) aynı saniyede, aynı boyutta değişen bir dosya (ör. `10` → `20`) bazen değişmemiş sayılıyordu; bu yüzden commit "onaylananla AYNI DEĞİL" hatasıyla duruyordu. Geçici index kopyası artık git'in zaman bilgisini koruyor.

## 1.4.0 — 2026-10-07

### Yeni
- **Görev başına repo kapsamı:** `related[].edit` artık bir tavan. Analist planına `## Repo kapsamı` bölümü yazar ve bu görev için hangi ilgili repoların yazılabilir olacağını seçer; kapsam plan onayında ayrıca gösterilir. Plan tavanı sadece daraltabilir; listede olmayan repo salt okunur kalır. Kayıtlı kapsam `resume`'da da korunur.
- **Kapsam talebi:** developer kapsam dışı bir değişiklik gerektiğinde workaround yazmak yerine `run/scope-request.md` yazar; döngü durur ve kullanıcı karar verir: tavan içinde genişlet, genişletmeden devam et ya da durdur. Etkileşimsiz çalıştırmada durur. Talepler ve kararlar `run/scope-requests.md` ve `run.json`'da saklanır.
- **Repolar arası sözleşme:** birden fazla repo değiştiğinde analist sözleşme değişikliğini ve sırasını (önce sağlayan, sonra tüketen) planlar; reviewer iki tarafın uyumunu kontrol eder.
- **`flowloop stats`:** çalıştırmaların ölçüm özeti (başarı, ilk incelemede PASS, reviewer ve kontrol hata oranları, tur, insan müdahalesi, kapsam talepleri, reddedilen işlemler, başarısızlık nedenleri, maliyet, süre). `--since 30d`, `--json`.
- **Kalıcı geçmiş:** her çalıştırma bitince özeti `.flowloop/history.jsonl`'a eklenir (git'te yerel olarak yok sayılır, `flowloop clean` silmez). Çalıştırma özetine başlangıç ve bitiş zamanı eklendi.

### Değişen
- **Planda kapsam bölümü yoksa ilgili repolar salt okunur.** Önceden `edit` verilen ilgili repolar her görevde yazılabilirdi; artık yazma için planın `## Repo kapsamı` bölümünde o reponun "yazılabilir" olarak seçilmesi gerekir. Bölümsüz planlarda (ör. önceki bir çalıştırmadan devralınan plan) uyarı verilir; gerekirse plan onayında yorumla güncellenir ya da geliştirme sırasında kapsam talebiyle genişletilir.

## 1.3.0 — 2026-10-07

### Değişen
- **Bütçe dolunca durmak yerine sorulur:** bir rolün bütçesi dolarsa ("reached maximum budget") etkileşimli terminalde ek bütçe istenir; onaylanırsa ajan aynı oturumdan, kaldığı yerden devam eder (maliyet çift sayılmaz). Onaylanmazsa hangi ayarın artırılacağı yazılır.

## 1.2.0 — 2026-10-06

### Yeni
- **Birbirine bağımlı projeler (`related`):** bir görevde birden fazla repo. Her ilgili repo için temiz çalışma kopyası; ajanlar hepsini okuyabilir, `edit` verilen yollarda değişiklik yapılabilir. Kontroller her repoda o reponun komutlarıyla çalışır; onayda bütün farklar birlikte görünür; değişen her repo ayrı branch, commit, push ve PR ile teslim edilir; Jira yorumunda hepsi listelenir. Yetkiler Claude'da da Cursor'da da aynı kurallarla zorlanır. Git reposu olmayan ortak klasörler de sadece okunur olarak eklenebilir.

### Değişen
- `paths.edit` varsayılanı artık `**` (bütün repo). Gizli dosyalara (`readDeny`), `.git`'e, `.flowloop`'a ve bağlanan klasörlere (`node_modules`) yine yazılamaz. İstenirse `src/**` gibi daraltılabilir.

### Düzeltme
- `src` klasörü olmayan projelerde (ör. .NET) `flowloop init` düzenlenebilir yolları boş bırakıyordu.

## 1.1.2 — 2026-10-05

### Düzeltme
- `src` klasörü olmayan projelerde (ör. proje adlı klasörleri olan .NET çözümleri) `flowloop init` düzenlenebilir yolları boş bırakıyordu ve `flowloop check` "paths.edit: expected array, received null" hatası veriyordu. Artık .csproj klasörleri ya da repodaki üst klasörler önerilir; boş bırakılırsa ne yazılacağı söylenir.
- Bilgisayarda nvm kuruluysa kurulum betiği "✓ git" satırından sonra sessizce duruyordu (nvm betiği `set -u` ile uyumsuz). nvm artık sadece Node bulunamazsa ve güvenli şekilde yükleniyor.
- Kurulum beklenmedik bir yerde durursa hangi satırda durduğu yazılıyor.

### Değişen
- Komut bayrakları İngilizce: `--plan-onayi` → `--approve-plan`, `--onaysiz` → `--skip-review`. Eski bayraklar bir süre daha uyarıyla çalışır.
- Kodda, testlerde ve dokümanlarda şirkete özel ad ve adres geçmez; örnekler genel (`sirket.atlassian.net`, `PROJ-1234`).
- `flowloop setup`'ta Jira adresi zorunlu: hazır bir adres önerilmez, adres girilmeden sonraki adıma geçilmez. Örnek olarak `https://sirket.atlassian.net` gösterilir.

## 1.1.1 — 2026-10-05

### Düzeltme
- Klasörü taşınmış eski `kgflow` kurulumu `flowloop` komutunun kurulmasını engelliyordu (`flowloop: command not found`). Kurulum betiği artık kırık eski bağlantıları kendisi kaldırıyor.
- Kurulum hatası artık gizlenmiyor: sebep (yetki / çakışan dosya) ve çözüm gösteriliyor; komut PATH'te değilse `~/.zshrc`'ye eklenecek satır yazılıyor.

## 1.1.0 — 2026-10-05

### Değişen
- **Projenin adı flowloop oldu** (repo adıyla aynı): komut `flowloop`, proje ayarı `.flowloop/flowloop.yaml`, kullanıcı klasörü `~/.flowloop`, ortam değişkenleri `FLOWLOOP_*`, branch öneki `flowloop/`.

### Uyumluluk
- `kgflow` komutu bir süre daha çalışır (uyarı verir).
- Projedeki `.kgflow/` (ve daha eski `.ekip/`) klasörü ilk komutta `.flowloop/`'a taşınır.
- Anahtar Zinciri'ndeki "kgflow" kayıtları, `~/.kgflow/config.json`, kurulum kaydı ve eski çalıştırmalar okunmaya devam eder; gizliler ilk kullanımda yeni yere taşınır.

## 1.0.0 — 2026-10-05

İlk sürüm.

### Akış
- Rol bazlı AI geliştirme ekibi: **analist → developer ⇄ reviewer → committer**. Rol yetkileri kodla zorlanır (dosya okuma/yazma, kabuk komutları, git); ihlal anında durdurulur.
- `kgflow run PROJ-1234`: görev doğrudan Jira'dan çekilir; temiz base branch'ten (`production → main → master`) ayrı bir worktree'de çalışılır.
- **Plan onayı:** onayla, yorum yazıp analiste güncellet (en fazla 5 tur) ya da iptal et. İptal edilen plan saklanır; görev yeniden çalışınca analiz tekrarlanmadan sunulur.
- **Commit'ten önce kullanıcı onayı:** değişen dosyalar ve tam fark gösterilir; onayla, değişiklik iste (developer uygular, reviewer isteği de denetler) ya da beklet (`kgflow resume`). `--onaysiz` ile atlanır.
- İş bitince branch push'lanır, PR bağlantısı verilir, Jira kaydına özet yorum düşer (Claude/Cursor, model ve başlatan bilgisiyle). Merge her zaman insandadır.
- `kgflow resume`: yarım kalan işi baştan başlatmadan sürdürür.

### Kalite kontrolleri
- Sadece bu işin testleri (`--findRelatedTests`), sadece bu işle gelen **yeni** tip ve lint hataları; lint uyarıları bloklamaz.
- Reviewer mutasyon testi yapar: kodu bir kopyada bozup testlerin yakaladığını doğrular.
- Projenin kuralları (`CLAUDE.md`, `.cursorrules`, `.cursor/rules`…), kişisel `~/.claude/CLAUDE.md` ve kod hafızası (MCP, salt okuma) bütün rollere verilir.
- Proje dersleri (`.kgflow/lessons.md`): reddedilen konular sonraki işlerde hatırlatılır.

### Ajanlar
- Claude Agent SDK; Claude erişimi yoksa Cursor CLI (`agent: auto | claude | cursor`, `--agent`). Cursor'da yetkiler hook'larla aynı politikadan zorlanır.

### Kurulum ve hesaplar
- Tek komutla kurulum (`git clone … ~/.kgflow/src && ~/.kgflow/src/install.sh`); Node yoksa kurulur.
- `kgflow setup`: git kimliği, Claude/Cursor, Jira adresi ve token'ı, Bitbucket SSH adım adım kurulur ve doğrulanır.
- `kgflow update`, günlük yeni sürüm uyarısı, `kgflow --version`.
- `kgflow init`: teknoloji tespiti (React Native/Expo, React, Next.js, Node, NestJS, .NET), `.kgflow/` klasörünü `.gitignore`'a ekler.

### Güvenlik
- Token'lar macOS Anahtar Zinciri'nde (Linux'ta sistem anahtarlığında) saklanır; hiçbir proje dosyasına yazılmaz.
- Ajanlar ve çalıştırdıkları testler gizli ortam değişkenlerini (`*_TOKEN`, `*_SECRET`, `JIRA_*`…) görmez.
- `.env` gibi dosyalar hiçbir rol tarafından okunamaz; force push, `--no-verify`, `--amend` engellidir.
