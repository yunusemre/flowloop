export type Verdict = "PASS" | "FAIL";

/** Reviewer çıktısının son anlamlı satırındaki kararı okur. Karar yoksa FAIL. */
export function parseVerdict(text: string): { verdict: Verdict; feedback: string; explicit: boolean } {
  const lines = text.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const clean = lines[i].replace(/[*_`#>]/g, "").trim();
    if (!clean) continue;
    const m = /^VERDICT:\s*(PASS|FAIL)\b/i.exec(clean);
    if (m) {
      const feedback = lines.slice(0, i).join("\n").trim();
      return { verdict: m[1].toUpperCase() as Verdict, feedback, explicit: true };
    }
    break; // son anlamlı satır karar değil
  }
  return { verdict: "FAIL", feedback: text.trim() + "\n\n(Reviewer son satırda VERDICT yazmadı; FAIL sayıldı.)", explicit: false };
}

/** FAIL geri bildiriminden kgflow hafızasına yazılacak kısa dersleri çıkarır. */
export function extractLessons(feedback: string, max = 6): string[] {
  return feedback
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("❌") || /HAYATTA KALDI/i.test(l))
    .map((l) => l.replace(/\s+/g, " ").slice(0, 240))
    .slice(0, max);
}
