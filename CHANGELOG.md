# Değişiklik günlüğü

Sürümler [Semantic Versioning](https://semver.org/lang/tr/) kuralına göre numaralanır: `MAJOR.MINOR.PATCH`.
1.0.0'a kadar MINOR sürümler yeni özellik ve ayar değişikliği getirebilir; değişiklik gerekiyorsa
`kgflow init --force` mevcut değerleri koruyarak ayar dosyasını yeniler.

## Yayınlanmadı

### Yeni
- **İş bitince commit'ten önce kullanıcı onayı:** değişen dosyalar ve fark gösterilir; `[e]` onayla, `[y]` değişiklik iste (developer uygular, reviewer isteği de kontrol eder), `[h]` beklet (`kgflow resume` ile sonra onaylanır). `--onaysiz` ile atlanır.

### Değişen
- **Jira adresi dışarıdan alınır:** kodda sabit adres yok. `kgflow setup` sorar (`~/.kgflow/config.json`); öncelik: `kgflow.yaml` → `JIRA_BASE_URL` → setup ayarı.
- Adres bir kez girildikten sonra görevler sadece anahtarla çalışır (`kgflow run IDT-1234`); yapıştırılan bağlantıdan da anahtar alınır.

## 0.3.0 — 2026-10-05

### Yeni
- **Plan onayında yorum:** `[y]` ile yorum yazılır, analist yorumu değerlendirip planı günceller (en fazla 5 tur). Katılmadığı noktaların gerekçesini yazar.
- **İptal edilen plan saklanır:** aynı görev yeniden çalışınca analiz tekrarlanmadan aynı plan sunulur; `[b]` ile baştan analiz.
- **`kgflow setup`:** git kimliği, Claude (abonelik token'ı ya da API anahtarı) / Cursor, Jira token ve Bitbucket SSH adım adım kurulur ve doğrulanır. Kurulum sonunda kendiliğinden açılır.
- **Gizli bilgiler anahtar zincirinde:** macOS Anahtar Zinciri, Linux'ta secret-tool ya da 600 izinli dosya.
- **Cursor desteği:** Claude erişimi yoksa ajanlar Cursor CLI ile çalışır (`agent: auto | claude | cursor`, `--agent`). Yetkiler Cursor hook'larıyla aynı politikadan zorlanır.
- **Tek komutla kurulum ve güncelleme:** `git clone … ~/.kgflow/src && ~/.kgflow/src/install.sh`; Node yoksa kurulur. `kgflow update` ve günlük yeni sürüm uyarısı. `kgflow --version`.
- **`kgflow resume`** reviewer onayı alamamış işi de sürdürür (kontroller → reviewer → commit → push → Jira).
- `kgflow init` `.kgflow/` klasörünü `.gitignore`'a ekler.
- Kullanım kılavuzu: `KULLANIM.md`.

### Değişen
- Projenin adı **ekip → kgflow** oldu (komut, `.kgflow/kgflow.yaml`, `~/.kgflow/work`). Eski `.ekip` klasörü ilk komutta otomatik taşınır.
- Lint kontrolü sadece **hataları** sayar; uyarılar bloklamaz. Varsayılan komut `npx eslint --quiet {{files}}`.
- Developer tüm projede `tsc` çalıştırmaz; yeni tip hataları her turdan sonra kgflow tarafından bildirilir.

### Güvenlik
- Ajanlar ve onların çalıştırdığı testler gizli ortam değişkenlerini (`*_TOKEN`, `*_SECRET`, `JIRA_*`, `AWS_*`…) görmez.

## 0.2.0 — 2026-10-04

- İş bitince branch'in push'lanması, PR bağlantısı ve Jira'ya özet yorum (Claude, model ve başlatan bilgisiyle).
- `kgflow run IDT-1234`: görev doğrudan Jira'dan çekilir.
- Proje kuralları (`CLAUDE.md`, `.cursorrules`…), kişisel `~/.claude/CLAUDE.md` ve kod hafızası (MCP, salt okuma).
- İşe odaklı kontroller: sadece bu işin testleri, sadece yeni tip/lint hataları; temiz base branch'ten worktree; teknoloji tespiti.

## 0.1.0 — 2026-10-03

- İlk sürüm: Claude Agent SDK üzerinde analist → developer ⇄ reviewer → committer akışı; rol yetkileri kodla zorlanır, mutasyon testi.
