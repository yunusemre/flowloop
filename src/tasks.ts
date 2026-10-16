import fs from "node:fs";
import path from "node:path";
import { FLOWLOOP_DIR, jiraBaseUrl, loadConfig, parseJiraLink } from "./config.js";
import { JIRA_KEY, fetchIssue, issueToTask } from "./jira.js";

/** Kullanıcıya gösterilecek kısa mesajlar (terminalde renkli, arayüzde mesaj) */
export interface Say {
  info(m: string): void;
  ok(m: string): void;
  warn(m: string): void;
}

/** Jira kaydından görev dosyası (.flowloop/tasks/KEY.md); varsa ve refresh yoksa olduğu gibi kullanılır */
export async function ensureJiraTask(root: string, key: string, say: Say, refresh = false, baseOverride?: string): Promise<string> {
  const rel = path.join(FLOWLOOP_DIR, "tasks", `${key}.md`);
  const abs = path.join(root, rel);
  if (fs.existsSync(abs) && !refresh) {
    say.info(`Görev dosyası mevcut, o kullanılıyor: ${rel} (Jira'dan yeniden çekmek için --refresh)`);
    return rel;
  }
  const baseUrl = baseOverride || jiraBaseUrl(loadConfig(root));
  say.info(`Jira'dan çekiliyor: ${key}`);
  const issue = await fetchIssue(key, baseUrl);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, issueToTask(issue, new Date()));
  say.ok(`${rel} oluşturuldu: ${issue.summary}`);
  if (!issue.acceptance) say.warn("Jira'da kabul kriteri alanı yok; analist açıklamadan çıkaracak. Plan onayıyla kontrol etmen önerilir.");
  return rel;
}

/** "IDT-1", Jira bağlantısı ya da görev dosyası yolu → görev dosyası (repo-göreli) */
export async function resolveTaskInput(root: string, input: string, say: Say, refresh = false): Promise<string> {
  const link = parseJiraLink(input);
  if (link) return ensureJiraTask(root, link.key, say, refresh, link.base);
  if (JIRA_KEY.test(input)) return ensureJiraTask(root, input, say, refresh);
  return input;
}
