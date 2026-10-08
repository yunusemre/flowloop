import fs from "node:fs";
import path from "node:path";
import type { Logger } from "./log.js";
import { parseOpenQuestions, type OpenQuestion } from "./notes.js";

/**
 * Açık sorular döngüsü: plan "## Açık sorular" içeriyorsa kullanıcıya sorar (ya da ayara göre
 * Jira'ya yazar / varsayılanla geçer), cevapları plana işletir. Tek görevde ve toplu planda aynıdır.
 */

/** Açık sorulara kullanıcının kararı; answers: soru kimliği → cevap (boş = analistin varsayılanı) */
export type QuestionDecision = { action: "answer"; answers: Record<string, string> } | { action: "assume" } | { action: "jira" } | { action: "cancel" };
export type QuestionsMode = "ask" | "jira" | "assume";
export type AskQuestions = (questions: OpenQuestion[], ctx: { round: number; canPostToJira: boolean }) => Promise<QuestionDecision>;

/** Açık sorular için en fazla kaç cevap turu yapılır (sonra kalanlar varsayılanla geçilir) */
export const MAX_QUESTION_ROUNDS = 3;

export interface QuestionRecord {
  round: number;
  id: string;
  text: string;
  /** Sorunun ait olduğu görev (toplu planda) */
  key?: string;
  answer?: string;
  /** Cevapsız geçildi: kullanılan varsayılan */
  assumed?: string;
}

/** Açık soruların düz metin listesi (dosya, terminal ve ajan mesajı için) */
export function questionsMarkdown(qs: OpenQuestion[]): string {
  return qs.map((q) => `- ${q.id}${q.key ? ` (${q.key})` : ""}: ${q.text.replace(/\n/g, "\n  ")}${q.fallback ? `\n  Cevap gelmezse: ${q.fallback}` : ""}`).join("\n");
}

/** Açık sorular için Jira yorumu */
export function questionsComment(qs: OpenQuestion[], footer: string): string {
  return [
    "## flowloop: geliştirmeye başlamadan önce netleşmesi gerekenler",
    "",
    "Analist görevi inceledi. Aşağıdaki sorular cevaplanmadan geliştirmeye geçilmedi; cevapları bu kayda yorum olarak yazabilirsiniz.",
    "",
    ...qs.map((q, i) => `${i + 1}. *${q.id}:* ${q.text.replace(/\s*\n\s*/g, " — ")}${q.fallback ? ` _(Cevap gelmezse: ${q.fallback.replace(/\s*\n\s*/g, " ")})_` : ""}`),
    "",
    "---",
    footer,
  ].join("\n");
}

/** Sorunun ait olduğu görev: soruda yazan anahtar (listede varsa), yoksa ilk görev */
export function questionKey(q: OpenQuestion, keys: string[]): string {
  if (q.key && keys.includes(q.key)) return q.key;
  const inText = keys.find((k) => new RegExp(`\\b${k}\\b`).test(q.text));
  return inText ?? keys[0];
}

export interface QuestionLoop {
  planFile: string;
  runRoot: string;
  mode: QuestionsMode;
  ask?: AskQuestions;
  /** Soruların yazılabileceği Jira kayıtları (ilk = varsayılan). Boşsa Jira'ya yazılamaz. */
  jiraKeys: string[];
  /** Bir Jira kaydına yorum yazar, bağlantısını döner */
  postToJira?: (key: string, body: string) => Promise<string>;
  /** Jira yorumunun imza satırı */
  footer: string;
  records: QuestionRecord[];
  log: Logger;
  /** Analisti cevaplarla yeniden çalıştırır (plan güncellenir) */
  reanalyze: (feedback: string) => Promise<void>;
  /** Cevapları sonraki rollerin göreceği bağlama ekler */
  appendContext: (block: string) => void;
  save: () => void;
  fail: (msg: string) => never;
  /** Yeniden çalıştırma komutu (mesajlar için), ör. "flowloop run PROJ-1" */
  rerun: string;
  onPosted?: (urls: string[]) => void;
}

export async function resolveQuestions(l: QuestionLoop): Promise<void> {
  for (let round = 1; ; round++) {
    const qs = parseOpenQuestions(fs.readFileSync(l.planFile, "utf8"));
    if (!qs.length) return;
    l.log.warn(`Analist ${qs.length} açık soru yazdı; cevaplanmadan geliştirmeye geçilmez.`);
    l.log.info(questionsMarkdown(qs).split("\n").map((x) => "  " + x).join("\n"));
    const canPostToJira = !!(l.postToJira && l.jiraKeys.length);
    let d: QuestionDecision;
    if (l.mode === "assume") d = { action: "assume" };
    else if (round > MAX_QUESTION_ROUNDS) {
      l.log.warn(`${MAX_QUESTION_ROUNDS} cevap turundan sonra hâlâ soru var; kalanlar analistin varsayılanıyla geçiliyor.`);
      d = { action: "assume" };
    } else if (l.ask) d = await l.ask(qs, { round, canPostToJira });
    else d = l.mode === "jira" && canPostToJira ? { action: "jira" } : { action: "cancel" };
    const keyFor = (q: OpenQuestion) => (l.jiraKeys.length > 1 ? questionKey(q, l.jiraKeys) : undefined);

    if (d.action === "cancel") {
      for (const q of qs) l.records.push({ round, id: q.id, text: q.text, key: keyFor(q) });
      const file = path.join(l.runRoot, "questions.md");
      fs.writeFileSync(file, questionsMarkdown(qs) + "\n");
      l.fail(
        `Açık sorular cevaplanmadı; geliştirmeye geçilmedi. Sorular: ${file}\n` +
          `  Cevaplamak için etkileşimli terminalde yeniden çalıştır: ${l.rerun}\n` +
          `  Etkileşimsiz çalıştırmalar için flowloop.yaml → questions: jira (Jira'ya yaz) ya da assume (varsayılanla devam).`,
      );
    }
    if (d.action === "jira") {
      for (const q of qs) l.records.push({ round, id: q.id, text: q.text, key: keyFor(q) });
      if (!canPostToJira) l.fail("Sorular Jira'ya yazılamadı: görev Jira'dan gelmiyor ya da Jira adresi tanımlı değil.");
      // toplu planda her soru kendi görevine yazılır
      const groups = new Map<string, OpenQuestion[]>();
      for (const q of qs) {
        const k = questionKey(q, l.jiraKeys);
        groups.set(k, [...(groups.get(k) ?? []), q]);
      }
      const urls: string[] = [];
      for (const [k, group] of groups) {
        try {
          urls.push(await l.postToJira!(k, questionsComment(group, l.footer)));
        } catch (e) {
          l.fail(`Sorular Jira'ya yazılamadı (${k}): ${(e as Error).message}`);
        }
      }
      l.onPosted?.(urls);
      l.save();
      for (const u of urls) l.log.ok(`Açık sorular Jira'ya yazıldı: ${u}`);
      l.fail(
        `Açık sorular Jira'ya yazıldı, cevap bekleniyor: ${urls.join(" , ")}\n` +
          `  Cevaplar Jira'ya yazılınca görevi yeniden çek ve çalıştır: ${l.rerun} --refresh`,
      );
    }
    if (d.action === "assume") {
      for (const q of qs) l.records.push({ round, id: q.id, text: q.text, key: keyFor(q), assumed: q.fallback ?? "(varsayılan önerilmedi)" });
      l.appendContext(
        "## Cevaplanmadan geçilen açık sorular\n\n" +
          "Bu sorular cevaplanmadı. Planda \"Cevap gelmezse\" yazan varsayılanla ilerle ve bunu özetinde belirt.\n\n" +
          questionsMarkdown(qs),
      );
      l.save();
      l.log.info("Açık sorular analistin varsayılanlarıyla geçildi; Jira yorumunda listelenecek.");
      return;
    }
    if (d.action !== "answer") return;
    const block = qs
      .map((q) => {
        const a = (d.answers[q.id] ?? "").trim();
        l.records.push({ round, id: q.id, text: q.text, key: keyFor(q), answer: a || undefined, assumed: a ? undefined : q.fallback ?? "(varsayılan önerilmedi)" });
        return `- ${q.id}${q.key ? ` (${q.key})` : ""}: ${q.text.replace(/\s*\n\s*/g, " ")}\n  Cevap: ${a ? a.replace(/\n/g, "\n  ") : `(cevap verilmedi — önerdiğin varsayılanla ilerle${q.fallback ? `: ${q.fallback}` : ""})`}`;
      })
      .join("\n");
    fs.appendFileSync(path.join(l.runRoot, "answers.md"), `## ${round}. tur\n${block}\n\n`);
    l.appendContext(`## Kullanıcının açık sorulara cevapları${round > 1 ? ` (${round}. tur)` : ""}\n\n${block}`);
    l.save();
    l.log.step(`ANALİST  (cevaplarınla planı güncelliyor — ${round}. tur)`);
    await l.reanalyze(`KULLANICI AÇIK SORULARI CEVAPLADI:\n${block}\n\nCevapları plana işle (revizyon kurallarının 4. maddesi).`);
  }
}
