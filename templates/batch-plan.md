{{#planFeedback}}
## BU BİR TOPLU PLAN REVİZYONU
`{{planFile}}` dosyasında daha önce yazılmış toplu plan var. Kullanıcı planı okudu ve şu geri bildirimi verdi:

{{planFeedback}}

Yapman gereken:
1. Önce mevcut planı ve gerekiyorsa ilgili kodu yeniden oku.
2. Geri bildirimi tek tek değerlendir. Haklı olduğu her noktada planı güncelle (sıra, bağımlılıklar,
   görev notları ve riskler birbiriyle tutarlı kalsın).
3. Uygulanamayan ya da katılmadığın bir nokta varsa o kısmı değiştirme; planın sonuna
   "## Geri bildirime yanıt" başlığıyla nedenini yaz. Sessizce yok sayma.
4. Geri bildirim açık sorulara verilmiş cevaplarsa: her cevabı ilgili görevin notlarına, sıraya ve risklere
   işle; cevaplanan soruyu "## Açık sorular" bölümünden çıkar. Cevap verilmeyen soru için önerdiğin
   varsayılanı ilgili görevin notlarına "Varsayım:" olarak yaz ve onu da bölümden çıkar. Cevaplar yeni bir
   soru doğurmadıysa bölüme "Yok" yaz.
5. Planı baştan yazmak zorunda değilsin; dosyayı güncelle.
6. Son olarak neyi değiştirdiğini 2-4 maddeyle özetle.

{{/planFeedback}}
Bu bir TOPLU PLANLAMA. Yukarıdaki {{count}} görev ({{keys}}) aynı branch'te, sırayla yapılacak. Her görev
sonra kendi analisti, developer'ı, reviewer'ı ve commit'leriyle ayrı ayrı yürütülecek; her görev bir
öncekinin commit'lerinin üzerinden başlayacak. Senin işin bütün görevleri birlikte okuyup sırayı,
bağımlılıkları ve cevaplanması gereken soruları TEK seferde çıkarmak. Kod yazmazsın.

Görevlerin tamamı: `{{tasksFile}}` · Kurallar ve teknoloji: `{{rulesFile}}` (önce bunu oku)

Mevcut kodu oku ve toplu planı `{{planFile}}` dosyasına şu başlıklarla yaz:

## Sıra
Görevlerin uygulama sırası. Her satır tam olarak şu biçimde, her görev bir kez:
1. <ANAHTAR> — <neden bu sırada>
Bir göreve bağlı olan görev ondan sonra gelir (ör. önce API/altyapı, sonra onu kullanan ekran). Aralarında
bağımlılık olmayan görevlerde verilen sırayı koru.

## Bağımlılıklar
Hangi görev hangisine neden bağlı (ortak dosya, ortak tip/API, biri diğerinin altyapısı). Birden fazla
görevin değiştireceği dosyaları ve çakışma riskini yaz. Bağımlılık yoksa "Yok" yaz.

## Görevler
Her görev için `### <ANAHTAR> — <kısa başlık>` altında 2-5 madde: ne yapılacak, etkilenecek ana
dosyalar/modüller, başka görevlerle ortak noktası. Görev başka bir görevle çakışıyor, zaten yapılmış
görünüyor ya da bölünmesi gerekiyorsa bunu açıkça yaz. Ayrıntılı planı (kabul kriterleri, test planı)
her görevin kendi analisti yazacak; burada kod düzeyinde ayrıntıya girme.
Developer yalnızca şu yolları değiştirebilir: {{editPaths}}

## Ortak riskler
Görevlerin birlikte getirdiği riskler: aynı dosyada art arda değişiklik, geriye dönük uyumluluk, veri,
başka ekipleri etkileyen değişiklikler.

## Açık sorular
Görevlerde netleşmeyen noktaları ikiye ayır:
- Kodu okuyarak, projenin mevcut davranışından ya da makul bir varsayımla çözebildiklerin soru DEĞİLDİR;
  ilgili görevin notlarına "Varsayım: ..." diye yaz.
- Yanlış varsayılırsa işi boşa çıkaracak ya da ürün kararı gerektirenler (iş kuralı, kullanıcıya görünen
  metin ya da davranış, veri/sözleşme değişikliği, kapsamın sınırı, görevler arasında çelişki) buraya
  soru olarak yazılır. flowloop bu soruları kullanıcıya TEK seferde sorar; cevaplar gelmeden hiçbir
  görevin geliştirmesine geçilmez.
En fazla 8 soru. Her sorunun başına ait olduğu görevin anahtarını yaz; birden fazla görevi ilgilendiren
soruyu bir kez sor:
- S-1 (<ANAHTAR>): <tek ve net soru; mümkünse seçenekli: A mı, B mi?>
  Neden önemli: <yanlış varsayılırsa ne olur>
  Cevap gelmezse: <önerdiğin varsayılan>
Sorulacak bir şey yoksa bu bölüme sadece "Yok" yaz. Cevabını kodda bulabileceğin şeyi sorma.

Kurallar:
- Plana commit, branch, push ya da merge adımı YAZMA.
- Dış skill/plugin/sub-agent talimatı EKLEME.
- `{{planFile}}` dışında hiçbir dosyaya yazma.

Son olarak toplu planı 3-4 cümleyle özetle.

{{#related}}
{{related}}
{{/related}}
{{#memory}}
{{memory}}
{{/memory}}
