/**
 * BeeHive operator-tooling catalog (BeeHiveTeam/monad-tools).
 *
 * Static metadata about each script + a cached GitHub API enrichment with
 * commit hash, last-modified date, line counts. Used by /tools/scripts to
 * render a live-ish status of each tool.
 *
 * Cache: 10 minutes per repo (GitHub unauthenticated rate limit is 60 req/h
 * per IP). Fits well within budget.
 */

const REPO_OWNER = 'BeeHiveTeam';
const REPO_NAME = 'monad-tools';
const REPO_BRANCH = 'main';
const CACHE_TTL_MS = 10 * 60_000;

export interface ScriptEntry {
  name: string;
  path: string;            // file path inside repo, e.g. "doctor/monad-doctor"
  purpose: string;         // one-liner for card title
  description: string;     // 2-3 sentences for body
  highlights: string[];    // bullets shown on card
  rawUrl: string;
  githubUrl: string;       // tree URL of the directory
  installCmd: string;
  // Live-fetched (may be null if API unavailable)
  lines: number | null;
  lastCommitSha: string | null;
  lastCommitDate: string | null;
}

export interface RepoMeta {
  url: string;
  description: string | null;
  stars: number;
  forks: number;
  lastCommitSha: string | null;
  lastCommitDate: string | null;
  defaultBranch: string;
}

export interface CatalogResponse {
  repo: RepoMeta;
  scripts: ScriptEntry[];
  fetchedAt: number;
  cacheAgeSeconds: number;
}

const STATIC_SCRIPTS: Omit<ScriptEntry, 'lines' | 'lastCommitSha' | 'lastCommitDate'>[] = [
  {
    name: 'monad-doctor',
    path: 'doctor/monad-doctor',
    purpose: 'Pre-flight readiness check',
    description:
      "50 checks across hardware, OS, network, security and Monad-specific config. " +
      "Catches the things operators learn about the hard way: SMT enabled in BIOS, " +
      "kernel in the buggy 6.8.0-{56..59} range, NVMe stuck on 4096-byte LBA, " +
      "vm.swappiness=60 inflating vote_delay, missing /dev/triedb udev SYMLINK, " +
      "CVE-2026-31431 algif_aead not blacklisted, or RPC ports publicly exposed (VDP risk).",
    highlights: [
      '5 sections — hardware / os / network / security / monad',
      '~30 second runtime, single bash file, zero deps',
      'Cross-references docs.monad.xyz for every check',
      '--json / --quick flags for CI integration',
    ],
    rawUrl: `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/doctor/monad-doctor`,
    githubUrl: `https://github.com/${REPO_OWNER}/${REPO_NAME}/tree/${REPO_BRANCH}/doctor`,
    installCmd: `curl -fsSL https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/doctor/monad-doctor | sudo bash`,
  },
  {
    name: 'monad-validator-setup',
    path: 'validator-setup/monad-validator-setup',
    purpose: 'One-shot host configuration',
    description:
      "13 idempotent setup steps that take a fresh Ubuntu 24.04 box to a fully-configured " +
      "Monad node — sysctl tuning, ulimits, IO scheduler, chrony, monad apt repo, " +
      "monad user/dirs, /dev/triedb udev SYMLINK, monad-cruft.timer, UFW + iptables UDP " +
      "DDoS filter, bootstrap configs from MF_BUCKET. Per-network monad pin: " +
      "testnet → 0.14.3, mainnet → 0.14.2 (overridable via MONAD_PKG_VERSION).",
    highlights: [
      '--network=testnet|mainnet (interactive prompt or flag)',
      '--node-type=validator|full (different node.toml templates)',
      '--with-monitoring installs BeeHive monad-grafana stack',
      '--dry-run shows every change; backs up files (.bak.<timestamp>)',
    ],
    rawUrl: `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/validator-setup/monad-validator-setup`,
    githubUrl: `https://github.com/${REPO_OWNER}/${REPO_NAME}/tree/${REPO_BRANCH}/validator-setup`,
    installCmd: `git clone https://github.com/${REPO_OWNER}/${REPO_NAME}.git\ncd monad-tools && sudo ./validator-setup/monad-validator-setup`,
  },
  {
    name: 'monad-watchdog',
    path: 'watchdog/monad-watchdog',
    purpose: 'Stuck-node auto-recovery (cron)',
    description:
      "Detects and recovers a stuck full-node from cron. Targets the 'local timeout' " +
      "deadlock — a node that drops below its upstream-validator target freezes its " +
      "block-tree root and can never self-recover; a process restart is the only fix. " +
      "Restart decisions are RPC-derived (block FROZEN or large GAP) and guarded: never " +
      "restarts on an unreachable RPC, and during statesync it stays hands-off but alerts " +
      "if the synced height stalls (peer-statesync that can't complete needs a hard reset).",
    highlights: [
      "Recovers the 'local timeout' deadlock automatically — every 5 min",
      'RPC-driven triggers (FROZEN / GAP); never restarts on a blind 0',
      'Statesync-aware + stalled-statesync alert (the gap a restart can’t fix)',
      'Validator safety-gate: refuses to restart a node with a non-burn beneficiary',
      'Cooldown + escalation so it never restart-loops',
    ],
    rawUrl: `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/watchdog/monad-watchdog`,
    githubUrl: `https://github.com/${REPO_OWNER}/${REPO_NAME}/tree/${REPO_BRANCH}/watchdog`,
    installCmd:
      `sudo curl -fsSL https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/watchdog/monad-watchdog -o /usr/local/bin/monad-watchdog\n` +
      `sudo chmod +x /usr/local/bin/monad-watchdog\n` +
      `( sudo crontab -l 2>/dev/null | grep -v monad-watchdog; echo '*/5 * * * * /usr/local/bin/monad-watchdog >> /var/log/monad-watchdog.log 2>&1' ) | sudo crontab -`,
  },
];

interface CacheEntry {
  data: CatalogResponse;
  fetchedAt: number;
}
const g = globalThis as { __scriptsCatalogCache__?: CacheEntry };

async function fetchGitHub<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface GhRepo {
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  default_branch: string;
}
interface GhCommit {
  sha: string;
  commit: { committer: { date: string } };
}
interface GhContent { size: number }

async function buildCatalog(): Promise<CatalogResponse> {
  const apiBase = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;

  const [repoMeta, latestCommit] = await Promise.all([
    fetchGitHub<GhRepo>(apiBase),
    fetchGitHub<GhCommit[]>(`${apiBase}/commits?per_page=1&sha=${REPO_BRANCH}`),
  ]);

  // Per-script latest commit (filter by file path) + line count via raw download
  const enriched = await Promise.all(
    STATIC_SCRIPTS.map(async (s): Promise<ScriptEntry> => {
      const [perFileCommit, raw] = await Promise.all([
        fetchGitHub<GhCommit[]>(`${apiBase}/commits?path=${encodeURIComponent(s.path)}&per_page=1&sha=${REPO_BRANCH}`),
        fetch(s.rawUrl, { signal: AbortSignal.timeout(8_000) })
          .then(r => r.ok ? r.text() : null)
          .catch(() => null),
      ]);
      return {
        ...s,
        lines: raw ? raw.split('\n').length : null,
        lastCommitSha: perFileCommit?.[0]?.sha?.slice(0, 7) ?? null,
        lastCommitDate: perFileCommit?.[0]?.commit?.committer?.date ?? null,
      };
    })
  );

  return {
    repo: {
      url: `https://github.com/${REPO_OWNER}/${REPO_NAME}`,
      description: repoMeta?.description ?? null,
      stars: repoMeta?.stargazers_count ?? 0,
      forks: repoMeta?.forks_count ?? 0,
      lastCommitSha: latestCommit?.[0]?.sha?.slice(0, 7) ?? null,
      lastCommitDate: latestCommit?.[0]?.commit?.committer?.date ?? null,
      defaultBranch: repoMeta?.default_branch ?? REPO_BRANCH,
    },
    scripts: enriched,
    fetchedAt: Date.now(),
    cacheAgeSeconds: 0,
  };
}

export async function getScriptsCatalog(): Promise<CatalogResponse> {
  const now = Date.now();
  const cached = g.__scriptsCatalogCache__;
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return {
      ...cached.data,
      cacheAgeSeconds: Math.floor((now - cached.fetchedAt) / 1000),
    };
  }
  const fresh = await buildCatalog();
  g.__scriptsCatalogCache__ = { data: fresh, fetchedAt: now };
  return fresh;
}
