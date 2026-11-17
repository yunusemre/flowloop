import { git } from "./git.js";

/** origin adresinden web bağlantıları (Bitbucket / GitHub / GitLab) */
export interface RemoteLinks {
  web: string;
  branch: (b: string) => string;
  pr: (b: string, base: string) => string;
}

/** SSH için kullanılan ana makine adları → web adresi (ör. 443 portundan SSH: ssh.bitbucket.org, ssh.github.com) */
const WEB_HOST: Record<string, string> = { "ssh.bitbucket.org": "bitbucket.org", "altssh.bitbucket.org": "bitbucket.org", "ssh.github.com": "github.com", "altssh.gitlab.com": "gitlab.com" };

/** Remote adresinden ana makine ve repo yolu: scp biçimi (git@host:yol), ssh://, https:// (port ve kullanıcı atılır) */
export function parseRemote(url: string): { host: string; repo: string } | undefined {
  let host = "";
  let repo = "";
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(url);
  if (/^[a-z+]+:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      host = u.hostname;
      repo = u.pathname.replace(/^\/+/, "");
    } catch {
      return undefined;
    }
  } else if (scp) {
    host = scp[1];
    repo = scp[2];
  } else return undefined;
  repo = repo.replace(/\/+$/, "").replace(/\.git$/, "");
  if (!host || !repo) return undefined;
  return { host: WEB_HOST[host.toLowerCase()] ?? host.toLowerCase(), repo };
}

export function remoteLinks(root: string): RemoteLinks | undefined {
  // ham ayar: kullanıcının global "url.<x>.insteadOf" yönlendirmesi (ör. SSH'ı 443'ten geçirmek) web adresini bozmasın
  const url = git(["config", "--get", "remote.origin.url"], root).stdout.trim() || git(["remote", "get-url", "origin"], root).stdout.trim();
  const p = parseRemote(url);
  if (!p) return undefined;
  const { host, repo } = p;
  const web = `https://${host}/${repo}`;
  const enc = encodeURIComponent;
  if (host.includes("bitbucket")) {
    return { web, branch: (b) => `${web}/branch/${enc(b)}`, pr: (b, base) => `${web}/pull-requests/new?source=${enc(b)}&dest=${enc(base)}` };
  }
  if (host.includes("gitlab")) {
    return { web, branch: (b) => `${web}/-/tree/${enc(b)}`, pr: (b, base) => `${web}/-/merge_requests/new?merge_request[source_branch]=${enc(b)}&merge_request[target_branch]=${enc(base)}` };
  }
  return { web, branch: (b) => `${web}/tree/${enc(b)}`, pr: (b, base) => `${web}/compare/${enc(base)}...${enc(b)}?expand=1` };
}
