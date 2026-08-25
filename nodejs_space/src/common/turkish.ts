/**
 * Turkce metin normallestirme.
 *
 * TEK KOPYA OLMASI ONEMLI: bu fonksiyon daha once hem TelegramService hem
 * TradeEngineService icinde ayri ayri duruyordu ve ikisi de ayni hatayi
 * tasiyordu.
 *
 * Hata suydu: once `toLowerCase()` cagriliyor, sonra `replace(/İ/g, 'i')`
 * deneniyordu. Ama JavaScript'te 'İ'.toLowerCase() tek bir 'i' uretmez —
 * 'i' + U+0307 (birlesik ustteki nokta) uretir. Dolayisiyla sonraki replace
 * hicbir sey bulamiyor ve geriye gorunmez bir birlesik karakter kaliyor:
 *
 *   "BAKİYE 100" -> "baki̇ye 100"   -> /^bakiye/ ESLESMIYOR
 *   "PİYASA"     -> "pi̇yasa"       -> /\bpiyasa\b/ ESLESMIYOR
 *
 * Telefon klavyeleri cumle basini otomatik buyutur, yani bu yol gunluk
 * kullanimda surekli tetikleniyordu: komut sessizce serbest sohbete dusuyor,
 * "bakiye" hic kaydedilmiyor ve bakiye null kaldigi icin kill switch ile
 * margin tavani birlikte devre disi kaliyordu.
 *
 * Cozum sirasi degistirmek: noktali/noktasiz buyuk I'ler toLowerCase'DEN
 * ONCE sadelestirilir, kalan birlesik noktalar da guvenlik agi olarak
 * temizlenir (metin baska bir kaynaktan zaten bozuk gelmis olabilir).
 */
export function normalizeTr(text: string): string {
  return (
    text
      // toLowerCase'den ONCE: yoksa 'İ' -> 'i' + U+0307 olur.
      .replace(/İ/g, 'i')
      .replace(/I/g, 'i')
      .toLowerCase()
      // Guvenlik agi: girdi zaten ayrisik halde gelmis olabilir.
      .replace(/̇/g, '')
      .replace(/ı/g, 'i')
      .replace(/ş/g, 's')
      .replace(/ğ/g, 'g')
      .replace(/ü/g, 'u')
      .replace(/ö/g, 'o')
      .replace(/ç/g, 'c')
      .trim()
  );
}
