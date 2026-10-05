import { git } from "./git.js";

/** origin adresinden web bağlantıları (Bitbucket / GitHub / GitLab) */
export interface RemoteLinks {
  web: string;
  branch: (b: string) => string;
  pr: (b: string, base: string) => string;
}

export function remoteLinks(root: string): RemoteLinks | undefined {
  const url = git(["remote", "get-url", "origin"], root).stdout.trim();
  const m = /^(?:git@|ssh:\/\/git@|https?:\/\/(?:[^@/]+@)?)([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(url);
  if (!m) return undefined;
  const host = m[1];
  const repo = m[2];
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
