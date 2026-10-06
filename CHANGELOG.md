# Değişiklik günlüğü

Sürümler [Semantic Versioning](https://semver.org/lang/tr/) kuralına göre numaralanır: `MAJOR.MINOR.PATCH`.

- **PATCH** (1.0.x): hata düzeltmesi; ayar dosyasında değişiklik gerekmez.
- **MINOR** (1.x.0): yeni özellik; mevcut ayarlar ve komutlar aynen çalışır.
- **MAJOR** (x.0.0): uyumsuz değişiklik; gerekenler burada yazılır (çoğunlukla `kgflow init --force` yeterlidir).

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
