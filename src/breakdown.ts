/**
 * İş kırılımı: analist planda işi küçük görevlere böler ve her birini 1-2-3-5-8 ölçeğinde puanlar.
 *
 *   ## İş kırılımı
 *   | Görev | Başlık | AK | Dosyalar | Bağımlı | Puan |
 *   |---|---|---|---|---|---|
 *   | T1 | GSM normalize yardımcısı | AK-1 | src/Common/Gsm*.cs | — | 1 |
 *
 * Görevler bağımlılık sırasıyla, her biri kendi kontrol + reviewer kapısından geçerek geliştirilir;
 * her görev ayrı commit olur. Küçük işte (tek görev ya da toplam puan ≤ 3) kırılım kullanılmaz.
 */
import picomatch from "picomatch";
import type { TaskQuality } from "./quality.js";

export const POINTS = [1, 2, 3, 5, 8] as const;
export type Points = (typeof POINTS)[number];

export interface BreakdownTask {
  id: string;
  title: string;
  ak: string[];
  /** Görevin dokunacağı yollar (glob olabilir) */
  files: string[];
  deps: string[];
  points: number;
}

/** Görevin çalıştırmadaki durumu (run.json) */
export interface BreakdownState extends BreakdownTask, TaskQuality {
  status: "pending" | "done";
  /** Görev onaylandığında çalışma ağacının hash'i (commit'ler bu noktalardan kurulur) */
  tree?: string;
  iterations?: number;
  costUsd?: number;
  durationMs?: number;
}

const SECTION = /^##\s+İş kırılımı\s*$/im;
const NONE = /^(—|-|–|yok|none)?$/i;

/** Plandaki "## İş kırılımı" tablosu; bölüm yoksa undefined */
export function parseBreakdown(plan: string): BreakdownTask[] | undefined {
  const m = SECTION.exec(plan);
  if (!m) return undefined;
  const rest = plan.slice(m.index + m[0].length);
  const end = rest.search(/^##\s/m);
  const body = end >= 0 ? rest.slice(0, end) : rest;
  const rows = body.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|"));
  const cells = (r: string) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const out: BreakdownTask[] = [];
  for (const r of rows) {
    const c = cells(r);
    if (c.length < 6 || /^:?-{2,}/.test(c[0]) || /^görev$/i.test(c[0])) continue;
    const list = (s: string) => s.split(/[,;]\s*|\s+ve\s+/).map((x) => x.replace(/`/g, "").trim()).filter((x) => x && !NONE.test(x));
    out.push({
      id: c[0].replace(/[`*]/g, "").toUpperCase(),
      title: c[1].replace(/[`*]/g, "").trim(),
      ak: list(c[2]).map((x) => x.toUpperCase()),
      files: list(c[3]).flatMap((x) => x.split(/\s+/)).filter(Boolean),
      deps: list(c[4]).map((x) => x.toUpperCase()),
      points: Number(c[5].replace(/[^\d]/g, "")),
    });
  }
  return out;
}

/** Plandaki AK numaraları (AK-1, AK-2 …) */
export function planAks(plan: string): string[] {
  const m = /^##\s+Kabul kriterleri\s*$/im.exec(plan);
  if (!m) return [];
  const rest = plan.slice(m.index + m[0].length);
  const end = rest.search(/^##\s/m);
  const body = end >= 0 ? rest.slice(0, end) : rest;
  return [...new Set([...body.matchAll(/\bAK-\d+\b/g)].map((x) => x[0]))];
}

/** Kırılımın kuralları: hatalar analiste geri gönderilir */
export function validateBreakdown(tasks: BreakdownTask[], aks: string[], editPaths: string[] = ["**"]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const t of tasks) {
    if (!/^T\d+$/.test(t.id)) errors.push(`"${t.id}": görev kimliği T1, T2 … biçiminde olmalı.`);
    if (ids.has(t.id)) errors.push(`${t.id} iki kez yazılmış.`);
    ids.add(t.id);
    if (!t.title) errors.push(`${t.id}: başlık boş.`);
    if (!(POINTS as readonly number[]).includes(t.points)) errors.push(`${t.id}: puan ${Number.isNaN(t.points) ? "yok" : t.points}; 1, 2, 3, 5 ya da 8 olmalı (8'den büyükse görevi böl).`);
    if (!t.files.length) errors.push(`${t.id}: dosya sütunu boş; görevin dokunacağı yolları yaz.`);
    if (!t.ak.length) errors.push(`${t.id}: hangi AK'yı karşıladığı yazılmamış.`);
  }
  const edit = picomatch(editPaths, { dot: true });
  for (const t of tasks) {
    for (const d of t.deps) if (!ids.has(d)) errors.push(`${t.id}: bağımlı olduğu ${d} kırılımda yok.`);
    // glob'un sabit kısmı izinli yollar içinde mi (developer zaten dışına yazamaz; analist yanlış yer planlamasın)
    for (const f of t.files) {
      const fixed = f.split(/[*?{[]/)[0].replace(/\/$/, "");
      if (fixed && !edit(fixed) && !edit(`${fixed}/x`) && !/[*?{[]/.test(f.slice(0, 1))) errors.push(`${t.id}: ${f} developer'ın yazabileceği yollar dışında (${editPaths.join(", ")}).`);
    }
  }
  for (const a of aks) if (!tasks.some((t) => t.ak.includes(a))) errors.push(`${a} hiçbir görevde yok; her AK en az bir göreve ait olmalı.`);
  const cyc = findCycle(tasks);
  if (cyc) errors.push(`Bağımlılıklarda döngü var: ${cyc.join(" → ")}.`);
  return errors;
}

function findCycle(tasks: BreakdownTask[]): string[] | undefined {
  const by = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 2) return undefined;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const d of by.get(id)?.deps ?? []) {
      const c = by.has(d) ? visit(d) : undefined;
      if (c) return c;
    }
    stack.pop();
    state.set(id, 2);
    return undefined;
  };
  for (const t of tasks) {
    const c = visit(t.id);
    if (c) return c;
  }
  return undefined;
}

/** Bağımlılık sırası: bağımlılığı biten görevler, aralarında tablodaki sırayla */
export function orderTasks<T extends BreakdownTask>(tasks: T[]): T[] {
  const done = new Set<string>();
  const out: T[] = [];
  const left = [...tasks];
  while (left.length) {
    const i = left.findIndex((t) => t.deps.every((d) => done.has(d) || !tasks.some((x) => x.id === d)));
    const next = left.splice(i >= 0 ? i : 0, 1)[0]; // döngü olursa (doğrulamadan geçmez) tablodaki sırayla
    out.push(next);
    done.add(next.id);
  }
  return out;
}

export const totalPoints = (tasks: BreakdownTask[]) => tasks.reduce((s, t) => s + (Number.isFinite(t.points) ? t.points : 0), 0);

/** Kırılım kullanılır mı: en az iki görev ve toplam puan 3'ten büyük (küçük iş bugünkü akışla) */
export const usesBreakdown = (tasks: BreakdownTask[] | undefined): tasks is BreakdownTask[] => !!tasks && tasks.length >= 2 && totalPoints(tasks) > 3;

/** Görevin geliştirme bütçesi: puanla ölçeklenir (3 puan = gelistir bütçesi) */
export function pointBudget(points: number, base: number): number {
  const k: Record<number, number> = { 1: 0.5, 2: 0.75, 3: 1, 5: 1.5, 8: 2 };
  return Math.round(base * (k[points] ?? 1) * 100) / 100;
}

/** Developer'a ve reviewer'a o turda odaklanacakları görev */
export function focusNote(task: BreakdownTask, all: BreakdownState[], role: "developer" | "reviewer"): string {
  const i = all.findIndex((t) => t.id === task.id);
  const done = all.filter((t) => t.status === "done").map((t) => t.id);
  const later = all.slice(i + 1).map((t) => t.id);
  const head = `\n\n## Şu anki görev: ${task.id}/${all.length} — ${task.title} (puan ${task.points})\n` +
    `Kabul kriterleri: ${task.ak.join(", ")}\nDosyalar: ${task.files.join(", ")}\n` +
    (done.length ? `Tamamlanan ve onaylanan görevler: ${done.join(", ")} (bunların değişiklikleri çalışma kopyasında duruyor).\n` : "");
  return role === "developer"
    ? head +
        `Bu turda SADECE ${task.id} görevini yap; ${later.length ? `sonraki görevlere (${later.join(", ")}) geçme, ` : ""}` +
        `onaylanmış görevlerin değişikliklerini bozma. Görevin dosyaları dışında bir değişiklik zorunluysa yap ama özetinde gerekçesini yaz.`
    : head +
        `Bu incelemede SADECE ${task.id}'nin kabul kriterlerini ve değişikliklerini değerlendir. Önceki görevler onaylandı; ` +
        `onları yeniden açma, ama bu görev onları bozduysa FAIL ver. ${later.length ? `Sonraki görevlerin (${later.join(", ")}) eksikliği FAIL sebebi değildir.` : ""}`;
}

/** Jira yorumu ve kayıt için özet tablo */
export function breakdownTable(tasks: BreakdownState[]): string {
  return [
    "| Görev | Başlık | AK | Puan | Tur |",
    "|---|---|---|---|---|",
    ...tasks.map((t) => `| ${t.id} | ${t.title.replace(/\|/g, "/")} | ${t.ak.join(", ")} | ${t.points} | ${t.iterations ?? "—"} |`),
  ].join("\n");
}

/** Görevin değiştirdiği dosyalardan plandaki dosya listesine uymayanlar (analistin dosya tahmini isabeti) */
export function filesOutside(task: BreakdownTask, changed: string[]): string[] {
  const match = picomatch(task.files.map((f) => f.replace(/^\.\//, "")), { dot: true });
  return changed.filter((f) => !match(f));
}
