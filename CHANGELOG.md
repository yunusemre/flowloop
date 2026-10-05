# Değişiklik günlüğü

Sürümler [Semantic Versioning](https://semver.org/lang/tr/) kuralına göre numaralanır: `MAJOR.MINOR.PATCH`.

- **PATCH** (1.0.x): hata düzeltmesi; ayar dosyasında değişiklik gerekmez.
- **MINOR** (1.x.0): yeni özellik; mevcut ayarlar ve komutlar aynen çalışır.
- **MAJOR** (x.0.0): uyumsuz değişiklik; gerekenler burada yazılır (çoğunlukla `kgflow init --force` yeterlidir).

## 1.0.0 — 2026-10-05

İlk sürüm.

### Akış
- Rol bazlı AI geliştirme ekibi: **analist → developer ⇄ reviewer → committer**. Rol yetkileri kodla zorlanır (dosya okuma/yazma, kabuk komutları, git); ihlal anında durdurulur.
- `kgflow run IDT-1234`: görev doğrudan Jira'dan çekilir; temiz base branch'ten (`production → main → master`) ayrı bir worktree'de çalışılır.
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
