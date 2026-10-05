import { isMap, isScalar, parseDocument } from "yaml";

/**
 * `kgflow init --force`: yeni şablonu (yorumlarıyla) üretir ama kullanıcının
 * mevcut ayarlarını korur. Teknoloji tespiti (stack, tech) her zaman yenilenir;
 * diğer tüm alanlarda eski değer (boş değilse) kazanır. Yeni eklenen alanlar
 * şablondaki varsayılanıyla gelir.
 */
const ALWAYS_REDETECT = new Set(["version", "stack", "tech"]);

export function mergeConfig(freshText: string, oldText: string): { text: string; kept: string[] } {
  const fresh = parseDocument(freshText);
  const old = parseDocument(oldText).toJS() as Record<string, unknown> | null;
  const kept: string[] = [];
  if (!old || typeof old !== "object") return { text: freshText, kept };

  const isEmpty = (v: unknown) => v === "" || v === null || v === undefined || (Array.isArray(v) && v.length === 0 && false);

  const walk = (prefix: string[], value: unknown) => {
    const key = prefix.join(".");
    if (prefix.length === 1 && ALWAYS_REDETECT.has(prefix[0])) return;
    const node = fresh.getIn(prefix, true);
    // iç içe nesnelerde alan alan birleştir (ör. jira.baseUrl korunur, jira.comment yeni gelir)
    if (value && typeof value === "object" && !Array.isArray(value) && (node === undefined || isMap(node))) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk([...prefix, k], v);
      return;
    }
    if (isEmpty(value)) return; // eski boşsa yeni tespit edilen değeri kullan
    const current = fresh.getIn(prefix);
    if (JSON.stringify(current) === JSON.stringify(value)) return;
    if (isScalar(node)) node.value = value;
    else fresh.setIn(prefix, value);
    kept.push(key);
  };
  for (const [k, v] of Object.entries(old)) walk([k], v);
  return { text: fresh.toString(), kept };
}
