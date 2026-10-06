import fs from "node:fs";
import path from "node:path";
import { ScopedChecks, type CheckResult, type CheckRunner } from "./checks.js";
import { CONFIG_FILE, loadConfig, relatedPath, type FlowloopConfig } from "./config.js";
import { changedExisting, changedPaths, diffAgainst, git, gitOk, headSha, sh, statusPorcelain, workingTreeHash } from "./git.js";
import type { Logger } from "./log.js";
import { remoteLinks } from "./remote.js";
import { detectBaseBranch, detectProject } from "./tech.js";
import picomatch from "picomatch";

/** Çalıştırma kaydında (run.json) ilgili repo bilgisi */
export interface RelatedSummary {
  name: string;
  /** Kullanıcının bilgisayarındaki repo */
  root: string;
  wt: string;
  baseWt: string;
  branch: string;
  baseBranch: string;
  baseRef: string;
  baseSha: string;
  edit: string[];
  linkDirs: string[];
  approvedTree?: string;
  commits?: string[];
  pushed?: boolean;
  branchUrl?: string;
  prUrl?: string;
}

type Commands = FlowloopConfig["commands"];

/**
 * Bağımlı bir repo: kendi temiz çalışma kopyası, branch'i, kontrolleri ve teslimi vardır.
 * Ajanlar onu "@ad:" önekli yollarla görür; komutlarını (test/lint/tip) flowloop çalıştırır.
 */
export class RelatedRepo {
  readonly checks: ScopedChecks;
  private editMatch: (p: string) => boolean;

  constructor(
    readonly s: RelatedSummary,
    readonly commands: Commands,
    readonly readDeny: string[],
    runner?: CheckRunner,
  ) {
    this.checks = new ScopedChecks({ commands } as FlowloopConfig, s.wt, s.baseWt, runner);
    this.editMatch = s.edit.length ? picomatch(s.edit, { dot: true }) : () => false;
  }

  get name() {
    return this.s.name;
  }
  get editable() {
    return this.s.edit.length > 0;
  }

  /** İlgili reponun ayarı: kendi flowloop.yaml'ı varsa o, yoksa otomatik tespit */
  static projectSettings(root: string): { commands: Commands; readDeny: string[]; linkDirs: string[]; baseBranch: string; source: string } {
    if (fs.existsSync(path.join(root, CONFIG_FILE))) {
      try {
        const c = loadConfig(root);
        return { commands: c.commands, readDeny: c.paths.readDeny, linkDirs: c.linkDirs, baseBranch: c.baseBranch, source: CONFIG_FILE };
      } catch {
        /* geçersizse tespit edilene düş */
      }
    }
    const d = detectProject(root);
    // teknoloji tanınmadıysa tahmini komut çalıştırma: kontroller atlanır (testler insan/CI'da)
    const commands = d.stack === "other" ? { ...d.commands, testRelated: "", typecheck: "", lint: "", format: "" } : d.commands;
    return { commands, readDeny: d.readDeny, linkDirs: d.linkDirs, baseBranch: "", source: `otomatik (${d.stack})` };
  }

  /** Temiz base'ten worktree açar; aynı adlı branch varsa -2, -3 ekler */
  static prepare(opts: {
    name: string;
    path: string;
    edit: string[];
    baseBranch: string;
    mainRoot: string;
    runDir: string;
    wantedBranch: string;
    fetch: boolean;
    log: Logger;
    runner?: CheckRunner;
  }): RelatedRepo {
    const root = relatedPath(opts.mainRoot, opts.path);
    const st = RelatedRepo.projectSettings(root);
    const baseBranch = opts.baseBranch || st.baseBranch || detectBaseBranch(root);
    if (!baseBranch) throw new Error(`${opts.name}: base branch bulunamadı (production/main/master yok); related.baseBranch ile belirt.`);
    if (opts.fetch && git(["remote"], root).stdout.includes("origin")) {
      const f = git(["fetch", "--quiet", "origin", baseBranch], root);
      if (f.code !== 0) opts.log.warn(`${opts.name}: origin/${baseBranch} çekilemedi; yerel kopya kullanılacak.`);
    }
    const remoteRef = `refs/remotes/origin/${baseBranch}`;
    const baseRef = git(["rev-parse", "--verify", "--quiet", remoteRef], root).code === 0 ? `origin/${baseBranch}` : baseBranch;
    const baseSha = gitOk(["rev-parse", baseRef], root);
    let branch = opts.wantedBranch;
    for (let n = 2; git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root).code === 0; n++) branch = `${opts.wantedBranch}-${n}`;
    const wt = path.join(opts.runDir, `wt-${opts.name}`);
    const baseWt = path.join(opts.runDir, `base-${opts.name}`);
    // sadece okunan repoda branch açmaya gerek yok: detached kopya yeterli
    if (opts.edit.length) gitOk(["worktree", "add", "-q", wt, "-b", branch, baseSha], root);
    else gitOk(["worktree", "add", "-q", "--detach", wt, baseSha], root);
    gitOk(["worktree", "add", "-q", "--detach", baseWt, baseSha], root);
    // bağımlılık klasörleri (node_modules vb.) repodan bağlanır
    const linked: string[] = [];
    for (const d of st.linkDirs) {
      const src = path.join(root, d);
      if (!fs.existsSync(src)) continue;
      for (const dst of [wt, baseWt]) if (!fs.existsSync(path.join(dst, d))) fs.symlinkSync(fs.realpathSync(src), path.join(dst, d), "dir");
      linked.push(d);
    }
    if (linked.length) ensureExcludedIn(root, linked);
    opts.log.ok(`İlgili repo hazır: ${opts.name} (${opts.edit.length ? `branch ${branch}` : "sadece okunur"}, base ${baseRef} ${baseSha.slice(0, 7)}, ayar: ${st.source})`);
    const s: RelatedSummary = { name: opts.name, root, wt, baseWt, branch: opts.edit.length ? branch : "", baseBranch, baseRef, baseSha, edit: opts.edit, linkDirs: linked };
    return new RelatedRepo(s, st.commands, st.readDeny, opts.runner);
  }

  /** run.json'dan (resume için) */
  static fromSummary(s: RelatedSummary, runner?: CheckRunner): RelatedRepo {
    const st = RelatedRepo.projectSettings(s.root);
    return new RelatedRepo(s, st.commands, st.readDeny, runner);
  }

  changed(): string[] {
    return changedExisting(this.s.wt, this.s.linkDirs);
  }
  hasChanges(): boolean {
    return statusPorcelain(this.s.wt, this.s.linkDirs).length > 0;
  }
  treeHash(): string {
    return workingTreeHash(this.s.wt, this.s.linkDirs);
  }

  /** Developer kapsam kontrolü: hata metni ya da undefined */
  scopeViolation(): string | undefined {
    if (headSha(this.s.wt) !== this.s.baseSha) return `${this.name} reposunda commit atılmış`;
    const outside = changedPaths(this.s.wt, this.s.linkDirs).filter((p) => !this.editMatch(p));
    if (outside.length) return `${this.name}: izinli yollar dışında değişiklik: ${outside.join(", ")}`;
    return undefined;
  }

  /** format + bu işin testleri + yeni tip/lint hataları (değişiklik yoksa boş) */
  runChecks(): CheckResult[] {
    const files = this.changed();
    if (!files.length) return [];
    const atBase = (fs_: string[]) => fs_.filter((f) => fs.existsSync(path.join(this.s.baseWt, f)));
    const results: CheckResult[] = [this.checks.format(files)];
    const after = this.changed();
    results.push(this.checks.tests(after, atBase(after)), this.checks.typecheck(after), this.checks.lint(after, atBase(after)));
    return results.map((r) => ({ ...r, repo: this.name }));
  }

  diffStat(): string {
    return diffAgainst(this.s.wt, this.s.baseSha, this.s.linkDirs, { stat: true });
  }
  diff(color = false): string {
    return diffAgainst(this.s.wt, this.s.baseSha, this.s.linkDirs, { color });
  }

  /**
   * Committer'ın yazdığı mesajla commit'ler (hook'lar çalışır). Commit'lenen içerik onaylananla
   * aynı değilse hata döner.
   */
  commit(messageFile: string, trailer: string, conventional: RegExp): string | undefined {
    if (!this.hasChanges()) return undefined;
    if (!fs.existsSync(messageFile) || !fs.readFileSync(messageFile, "utf8").trim()) return `${this.name}: commit mesajı yazılmamış (${path.basename(messageFile)})`;
    const msg = fs.readFileSync(messageFile, "utf8").trim();
    const subject = msg.split("\n")[0];
    if (!conventional.test(subject)) return `${this.name}: commit mesajı Conventional Commits'e uymuyor: ${subject}`;
    const full = msg.includes(trailer) ? msg : `${msg}\n\n${trailer}`;
    const tmp = `${messageFile}.final`;
    fs.writeFileSync(tmp, full + "\n");
    const ex = this.s.linkDirs.filter((d) => git(["check-ignore", "-q", d], this.s.wt).code !== 0);
    const add = sh("git", ["add", "-A", ...(ex.length ? ["--", ".", ...ex.map((e) => `:(exclude)${e}`)] : [])], this.s.wt);
    if (add.code !== 0) return `${this.name}: git add başarısız: ${add.stderr.trim()}`;
    const c = sh("git", ["commit", "-q", "-F", tmp], this.s.wt);
    if (c.code !== 0) return `${this.name}: commit başarısız (hook?): ${(c.stdout + c.stderr).trim().split("\n").slice(-5).join(" / ")}`;
    if (statusPorcelain(this.s.wt, this.s.linkDirs).length) return `${this.name}: commit sonrası değişiklik kaldı (commit hook'u dosya değiştirmiş olabilir)`;
    if (this.s.approvedTree && gitOk(["rev-parse", "HEAD^{tree}"], this.s.wt) !== this.s.approvedTree) return `${this.name}: commit'lenen içerik onaylananla AYNI DEĞİL`;
    this.s.commits = gitOk(["log", "--format=%h %s", `${this.s.baseSha}..HEAD`], this.s.wt).split("\n").filter(Boolean);
    return undefined;
  }

  /** Commit'lenmiş yarım işi geri al (resume için) */
  softReset(): void {
    if (headSha(this.s.wt) !== this.s.baseSha) gitOk(["reset", "-q", "--soft", this.s.baseSha], this.s.wt);
    gitOk(["reset", "-q"], this.s.wt);
  }

  removeWorktrees(): void {
    git(["worktree", "remove", "--force", this.s.baseWt], this.s.root);
    git(["worktree", "remove", "--force", this.s.wt], this.s.root);
    if (!this.s.commits?.length && this.s.branch) git(["branch", "-D", this.s.branch], this.s.root); // boş kalan branch'i bırakma
  }

  push(log: Logger): string | undefined {
    if (!this.s.commits?.length) return undefined;
    if (git(["remote", "get-url", "origin"], this.s.root).code !== 0) return `${this.name}: push atlandı (origin yok)`;
    const p = git(["push", "-u", "origin", `refs/heads/${this.s.branch}:refs/heads/${this.s.branch}`], this.s.root);
    if (p.code !== 0) return `${this.name}: push başarısız: ${p.stderr.trim().split("\n").slice(-2).join(" / ")}`;
    const links = remoteLinks(this.s.root);
    this.s.pushed = true;
    this.s.branchUrl = links?.branch(this.s.branch);
    this.s.prUrl = links?.pr(this.s.branch, this.s.baseBranch);
    log.ok(`Push edildi: ${this.name} → origin/${this.s.branch}`);
    return undefined;
  }

  /** Ajanlara anlatılacak satır */
  describe(): string {
    return this.editable
      ? `- ${this.name}: \`${this.s.wt}\` — değiştirilebilir yollar: ${this.s.edit.join(", ")} (testleri, tip ve lint kontrollerini flowloop çalıştırır)`
      : `- ${this.name}: \`${this.s.wt}\` — SADECE OKUNUR (bu repoda değişiklik yapma)`;
  }
}

/** Repo'nun ortak .git/info/exclude dosyasına kök-çapalı yollar ekler */
function ensureExcludedIn(root: string, dirs: string[]): void {
  const common = path.resolve(root, gitOk(["rev-parse", "--git-common-dir"], root));
  const file = path.join(common, "info", "exclude");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = new Set(current.split("\n").map((l) => l.trim()));
  const add = dirs.map((d) => `/${d.replace(/^\/+|\/+$/g, "")}`).filter((l) => !lines.has(l));
  if (add.length) fs.appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}# flowloop: yok sayılan yollar\n${add.join("\n")}\n`);
}

