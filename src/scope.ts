import fs from "node:fs";
import path from "node:path";

/**
 * Görev başına repo kapsamı.
 *
 * flowloop.yaml'daki `related[].edit` bir TAVANDIR: bir repoya en fazla o yollarda yazılabilir.
 * Analist planına "## Repo kapsamı" bölümü yazar ve bu görev için hangi ilgili repoların
 * yazılabilir olacağını seçer. Plan tavanı sadece DARALTABİLİR; ajan kendine yetki veremez.
 *
 *   ## Repo kapsamı
 *   - backend: yazılabilir
 *   - web: salt okunur
 */

export const SCOPE_HEADING = "Repo kapsamı";
export const SCOPE_REQUEST_FILE = "scope-request.md";

export interface ScopeRepo {
  name: string;
  /** flowloop.yaml'daki yazma yolları (tavan) */
  ceiling: string[];
}

export interface ResolvedScope {
  /** Plan bölümü bulundu mu (yoksa bütün ilgili repolar salt okunur) */
  fromPlan: boolean;
  /** Bu görevde her repo için geçerli yazma yolları ([] = salt okunur) */
  edit: Record<string, string[]>;
  warnings: string[];
}

const WRITABLE = /^(yaz[ıi]labilir|de[ğg]i[şs]tirilebilir|writable|edit)$/i;
const READONLY = /^(salt okunur|sadece okunur|okunur|read-?only)$/i;

/** Plan metnindeki "## Repo kapsamı" bölümü: ad → yazılabilir mi. Bölüm yoksa undefined. */
export function parseRepoScope(plan: string): Map<string, boolean> | undefined {
  const lines = plan.split("\n");
  const start = lines.findIndex((l) => /^#{2,3}\s+repo kapsam[ıi]\s*$/i.test(l.trim()));
  if (start < 0) return undefined;
  const out = new Map<string, boolean>();
  for (const raw of lines.slice(start + 1)) {
    const l = raw.trim();
    if (/^#{1,3}\s/.test(l)) break;
    const m = /^[-*]\s*`?([A-Za-z0-9._-]+)`?\s*[:→-]\s*(.+?)\s*\.?$/.exec(l);
    if (!m) continue;
    // "salt okunur (gerekçe)" gibi açıklamalar kabul edilir
    const value = m[2].replace(/\s*[(—–].*$/, "").trim();
    if (WRITABLE.test(value)) out.set(m[1], true);
    else if (READONLY.test(value)) out.set(m[1], false);
  }
  return out;
}

/**
 * Plan + tavan → bu görevin kapsamı.
 * - Bölüm yoksa: bütün ilgili repolar salt okunur (güvenli varsayılan), uyarı verilir.
 * - Bölüm varsa: sadece "yazılabilir" denen VE tavanı boş olmayan repolar yazılabilir;
 *   listede olmayan ya da okunamayan satırlar salt okunur sayılır (güvenli varsayılan).
 */
export function resolveScope(plan: string, repos: ScopeRepo[]): ResolvedScope {
  const edit: Record<string, string[]> = {};
  const warnings: string[] = [];
  const parsed = parseRepoScope(plan);
  if (!parsed) {
    // güvenli varsayılan: kapsam belirtilmediyse hiçbir ilgili repoya yazılamaz
    for (const r of repos) edit[r.name] = [];
    if (repos.some((r) => r.ceiling.length)) warnings.push(`Planda "## ${SCOPE_HEADING}" bölümü yok; bütün ilgili repolar salt okunur. Yazma gerekiyorsa planı yorumla güncellet (ör. "backend yazılabilir olsun").`);
    return { fromPlan: false, edit, warnings };
  }
  const known = new Set(repos.map((r) => r.name));
  for (const name of parsed.keys()) if (!known.has(name) && !/^(ana|main)/i.test(name)) warnings.push(`Repo kapsamı: "${name}" tanımlı bir ilgili repo değil; yok sayıldı.`);
  for (const r of repos) {
    const want = parsed.get(r.name) === true;
    if (want && !r.ceiling.length) warnings.push(`Repo kapsamı: ${r.name} için yazma istendi ama flowloop.yaml izin vermiyor (sadece okunur); tavan aşılamaz.`);
    edit[r.name] = want ? [...r.ceiling] : [];
  }
  return { fromPlan: true, edit, warnings };
}

/** Kapsamı tek satırda anlatır (plan onayı ve log için) */
export function describeScope(scope: ResolvedScope, repos: ScopeRepo[], source?: string): string {
  if (!repos.length) return "";
  const parts = repos.map((r) => {
    const e = scope.edit[r.name] ?? [];
    return `${r.name}: ${e.length ? `yazılabilir (${e.join(", ")})` : "salt okunur"}`;
  });
  return `Repo kapsamı (${source ?? (scope.fromPlan ? "plandan" : "planda belirtilmedi")}): ${parts.join(" · ")}`;
}

/** Tavanı olup şu an kapalı olan repolar: kapsam talebinde genişletilebilecekler */
export function expandableRepos(current: Record<string, string[]>, repos: ScopeRepo[]): string[] {
  return repos.filter((r) => r.ceiling.length && !(current[r.name] ?? []).length).map((r) => r.name);
}

export interface ScopeRequest {
  turn: number;
  text: string;
  decision?: "expand" | "continue" | "cancel";
  expanded?: string[];
}

/** Developer'ın yazdığı kapsam talebini okur, run klasöründeki kayda ekler ve dosyayı kaldırır */
export function takeScopeRequest(runRoot: string, turn: number): ScopeRequest | undefined {
  const f = path.join(runRoot, SCOPE_REQUEST_FILE);
  if (!fs.existsSync(f)) return undefined;
  const text = fs.readFileSync(f, "utf8").trim();
  fs.rmSync(f, { force: true });
  if (!text) return undefined;
  fs.appendFileSync(path.join(runRoot, "scope-requests.md"), `## Tur ${turn}\n${text}\n\n`);
  return { turn, text };
}
