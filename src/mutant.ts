import fs from "node:fs";
import path from "node:path";
import { failureLines, gitOk, runConfigured } from "./git.js";
import { currentVersion } from "./update.js";
import { linkDir, readText } from "./platform.js";
import { redact } from "./redact.js";

/** Kopyada çalıştırılacak test komutunu (ilgili testler) üretir. */
export type TestCommandFn = () => string;

/**
 * Mutasyon kum havuzu: reviewer gerçek kodu değil, run klasöründeki bir
 * kopyayı bozar. Kopyalama ve test çalıştırma deterministik olarak burada
 * yapılır; reviewer'a sadece iki araç verilir (mutant_reset, mutant_test).
 */
export class MutantSandbox {
  constructor(
    readonly repoRoot: string,
    readonly dir: string,
    readonly testCmd: TestCommandFn,
    readonly linkDirs: string[],
    readonly timeoutSec: number,
    /** Kopyada bir kez çalışan kurulum komutu (ör. dotnet restore); linkDirs ile bağlanamayan bağımlılıklar için */
    readonly installCmd = "",
  ) {}

  private get manifest() {
    return path.join(this.dir, ".flowloop-mutant.json");
  }

  /**
   * Kopyayı developer'ın son hâline getirir. İlk çağrıda dosyalar kopyalanır ve kurulum çalışır;
   * sonraki çağrılarda sadece kaynak dosyalar yeniden yazılır (kurulum çıktıları, ör. obj/, korunur),
   * developer'ın sildiği dosyalar kopyadan da silinir.
   */
  reset(): { files: number; installError?: string } {
    let previous: string[] | undefined;
    try {
      previous = JSON.parse(readText(this.manifest)).files;
    } catch {
      previous = undefined;
    }
    if (!previous) {
      fs.rmSync(this.dir, { recursive: true, force: true });
      fs.mkdirSync(this.dir, { recursive: true });
    }
    // izlenen + izlenmeyen (gitignore hariç) dosyalar = developer'ın son hâli
    const files = gitOk(["ls-files", "-co", "--exclude-standard", "-z", "--", ".", ...this.linkDirs.map((d) => `:(exclude)${d}`)], this.repoRoot)
      .split("\0")
      .filter((rel) => rel && fs.existsSync(path.join(this.repoRoot, rel)) && fs.lstatSync(path.join(this.repoRoot, rel)).isFile());
    const keep = new Set(files);
    for (const rel of previous ?? []) if (!keep.has(rel)) fs.rmSync(path.join(this.dir, rel), { force: true });
    for (const rel of files) {
      const src = path.join(this.repoRoot, rel);
      if (!fs.existsSync(src) || !fs.lstatSync(src).isFile()) continue;
      const dst = path.join(this.dir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    for (const d of this.linkDirs) {
      const link = path.join(this.repoRoot, d);
      if (!fs.existsSync(link) || fs.existsSync(path.join(this.dir, d))) continue;
      linkDir(fs.realpathSync.native(link), path.join(this.dir, d));
    }
    let installError: string | undefined;
    if (!previous && this.installCmd.trim()) {
      const r = runConfigured(this.installCmd, this.dir, this.timeoutSec * 1000, { fullEnv: true });
      if (r.code !== 0) installError = `Kopyada kurulum başarısız (${this.installCmd}): ${failureLines(r.stdout + "\n" + r.stderr, 5).join(" / ")}`;
    }
    fs.writeFileSync(this.manifest, JSON.stringify({ files }));
    return { files: files.length, installError };
  }

  test(): { code: number; output: string } {
    if (!fs.existsSync(this.dir)) return { code: -1, output: "Kopya yok; önce mutant_reset çağır." };
    const cmd = this.testCmd();
    if (!cmd.trim()) return { code: -1, output: "Bu işin testleri bu makinede çalıştırılamıyor (ör. .NET Framework projesi, sadece Windows). Bu AK için mutasyon kontrolü yapılamadı; FAIL verme, raporda 'çalıştırılamadı' yaz." };
    const t0 = Date.now();
    const r = runConfigured(cmd, this.dir, this.timeoutSec * 1000);
    try {
      fs.appendFileSync(mutantRunsFile(this.dir), JSON.stringify({ at: t0, ms: Date.now() - t0, code: r.code }) + "\n");
    } catch {
      /* ölçüm önemsiz */
    }
    const all = (r.stdout + "\n" + r.stderr).trim().split("\n");
    const tail = all.slice(-80).join("\n");
    // testler connection string ya da token basabilir: modele gitmeden maskelenir
    return { code: r.code, output: redact(`$ ${cmd}\n${tail}`) };
  }
}

/** Mutasyon test koşularının süre kaydı (kopya klasörünün yanında; kopya silinse de kalır) */
export function mutantRunsFile(dir: string): string {
  return `${dir.replace(/[\\/]+$/, "")}-runs.ndjson`;
}

/**
 * Ajanın flowloop'tan çalıştırabildiği kontroller. Komutu flowloop kurar (platform, .NET Framework,
 * yer tutucular); ajan sadece çağırır ve flowloop'un kendi kontrolüyle aynı sonucu görür.
 */
export interface CheckTools {
  tests(): string;
  typecheck?: () => string;
  lint?: () => string;
}

/** SDK'nın in-process MCP sunucusu: mutasyon araçları ve kontrol araçları (hangisi verildiyse) */
export async function createFlowloopServer(opts: { mutant?: MutantSandbox; checks?: CheckTools }) {
  const { createSdkMcpServer, tool } = await import("@anthropic-ai/claude-agent-sdk");
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const tools: any[] = [];
  const c = opts.checks;
  if (c) {
    tools.push(
      tool("run_tests", "Bu işin testlerini flowloop'un otomatik kontrolüyle AYNI komutla çalıştırır (değişen dosyalara göre). Sonucu ve kırılan testleri döner.", {}, async () => text(c.tests())),
    );
    if (c.typecheck) tools.push(tool("typecheck", "Tip kontrolü/derleme: sadece BU İŞLE GELEN yeni hataları döner (projede önceden var olanlar sayılmaz). Yavaş olabilir; bitirmeden önce bir kez çalıştır.", {}, async () => text(c.typecheck!())));
    if (c.lint) tools.push(tool("lint", "Değişen dosyalarda lint: sadece bu işle gelen yeni hataları döner.", {}, async () => text(c.lint!())));
  }
  const sandbox = opts.mutant;
  if (sandbox) tools.push(...mutantTools(sandbox, tool, text));
  return createSdkMcpServer({ name: "flowloop", version: currentVersion(), tools });
}

function mutantTools(sandbox: MutantSandbox, tool: any, text: (t: string) => unknown): unknown[] {
  return [
      tool(
        "mutant_reset",
        `Mutasyon kopyasını developer'ın güncel koduyla sıfırdan oluşturur (${sandbox.dir}). Her mutasyondan önce çağır.`,
        {},
        async () => {
          const r = sandbox.reset();
          return text(`Kopya hazır: ${sandbox.dir} (${r.files} dosya)${r.installError ? `\n${r.installError}` : ""}`);
        },
      ),
      tool(
        "mutant_test",
        `Kopyada bu işin testlerini çalıştırır ve çıkış kodunu + çıktının sonunu döner. Çıkış kodu 0 değilse en az bir test kırılmıştır.`,
        {},
        async () => {
          const r = sandbox.test();
          return text(`exit=${r.code}\n${r.output}`);
        },
      ),
  ];
}
