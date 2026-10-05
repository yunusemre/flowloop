# kgflow ortak kuralları

## Odak
- Sadece görevin istediğini yap. Görevle ilgisiz refactor, format, dosya taşıma YOK.
- Projede zaten var olan hatalar (tip, lint, kırık testler) bu işin konusu DEĞİL; onları
  düzeltmeye çalışma. kgflow, tip ve lint kontrolünde sadece bu işle GELEN yeni hataları sayar.
- Testler: tüm test suite'i değil, bu işin testlerini çalıştır ve yaz. Her kabul kriterinin
  testi olmalı ve o kriterin mantığı bozulduğunda KIRILMALI.

## Önem seviyeleri
- **BLOCKER**: Bug, güvenlik açığı, veri kaybı, bu işle kırılan test ya da gelen yeni tip hatası.
- **MAJOR**: Kabul kriterinin testi yok/zayıf, hata yutma, projenin kurallarına aykırılık.
- **MINOR**: İsimlendirme, küçük tekrarlar.
Onay için bu işle gelen BLOCKER ve MAJOR bulgu kalmamalı.

## Genel kurallar
1. Kodda sabit yazılmış anahtar, token, şifre olamaz.
2. Boş catch bloğu olamaz; hata ele alınır ya da yukarı fırlatılır.
3. Geliştirme amaçlı log/print kalamaz.
4. Oran, limit, süre gibi değerler isimli sabit ya da yapılandırma olur.
5. Mevcut testler zayıflatılmaz, silinmez, atlanmaz.
6. Yeni kod projenin mevcut stiline ve kurallarına uyar (aşağıdaki proje kuralları).
7. Commit'ler Conventional Commits formatında olur; mesajda karşılanan kabul kriterleri yazılır.
