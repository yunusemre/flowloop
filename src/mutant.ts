import fs from "node:fs";
import path from "node:path";
import { gitOk, runConfigured } from "./git.js";
import { currentVersion } from "./update.js";

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
  ) {}

  reset(): { files: number } {
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    // izlenen + izlenmeyen (gitignore hariç) dosyalar = developer'ın son hâli
    const files = gitOk(["ls-files", "-co", "--exclude-standard", "-z", "--", ".", ...this.linkDirs.map((d) => `:(exclude)${d}`)], this.repoRoot)
      .split("\0")
      .filter(Boolean);
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
      fs.symlinkSync(fs.realpathSync.native(link), path.join(this.dir, d), "dir");
    }
    return { files: files.length };
  }

  test(): { code: number; output: string } {
    if (!fs.existsSync(this.dir)) return { code: -1, output: "Kopya yok; önce mutant_reset çağır." };
    const cmd = this.testCmd();
    const r = runConfigured(cmd, this.dir, this.timeoutSec * 1000);
    const all = (r.stdout + "\n" + r.stderr).trim().split("\n");
    const tail = all.slice(-80).join("\n");
    return { code: r.code, output: `$ ${cmd}\n${tail}` };
  }
}

/** SDK'nın in-process MCP sunucusu olarak araçları üretir. */
export async function createMutantServer(sandbox: MutantSandbox) {
  const { createSdkMcpServer, tool } = await import("@anthropic-ai/claude-agent-sdk");
  return createSdkMcpServer({
    name: "kgflow",
    version: currentVersion(),
    tools: [
      tool(
        "mutant_reset",
        `Mutasyon kopyasını developer'ın güncel koduyla sıfırdan oluşturur (${sandbox.dir}). Her mutasyondan önce çağır.`,
        {},
        async () => {
          const r = sandbox.reset();
          return { content: [{ type: "text", text: `Kopya hazır: ${sandbox.dir} (${r.files} dosya)` }] };
        },
      ),
      tool(
        "mutant_test",
        `Kopyada bu işin testlerini çalıştırır ve çıkış kodunu + çıktının sonunu döner. Çıkış kodu 0 değilse en az bir test kırılmıştır.`,
        {},
        async () => {
          const r = sandbox.test();
          return { content: [{ type: "text", text: `exit=${r.code}\n${r.output}` }] };
        },
      ),
    ],
  });
}
