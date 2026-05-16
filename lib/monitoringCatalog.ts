/**
 * BeeHive monitoring stack catalog (BeeHiveTeam/monad-grafana).
 *
 * Mirrors the pattern of `lib/scriptsCatalog.ts` (single GitHub repo with
 * cached metadata enrichment) but exposes a single stack entry instead of
 * a list of bash scripts. The stack consists of multiple Docker containers
 * (Prometheus + Grafana + RPC exporter + node-exporter) deployed by one
 * install.sh script.
 *
 * Cache: 10 minutes per repo (GitHub unauthenticated rate limit is 60 req/h
 * per IP). Fits well within budget.
 */

const REPO_OWNER = 'BeeHiveTeam';
const REPO_NAME = 'monad-grafana';
const REPO_BRANCH = 'main';
const CACHE_TTL_MS = 10 * 60_000;

export interface StackComponent {
  name: string;
  port: string | null;            // host port or "loopback-only"
  image: string;
  purpose: string;
}

export interface MonitoringStack {
  name: string;
  purpose: string;
  description: string;
  highlights: string[];
  components: StackComponent[];
  rawUrl: string;                  // raw install.sh
  githubUrl: string;
  readmeUrl: string;
  installCmd: string;
  installCmdManual: string;
  upgradeCmd: string;
  uninstallCmd: string;
  healthcheckCmd: string;
  enableHostmetricsCmd: string;
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

export interface MonitoringCatalogResponse {
  repo: RepoMeta;
  stack: MonitoringStack;
  fetchedAt: number;
  cacheAgeSeconds: number;
}

const STATIC_STACK: MonitoringStack = {
  name: 'monad-grafana',
  purpose: 'Self-hosted Grafana + Prometheus monitoring for a Monad node',
  description:
    "Three Docker containers (Prometheus + Grafana + RPC exporter) plus a node-exporter " +
    "sidecar that scrape Monad's bundled OpenTelemetry collector on :8889. Renders a " +
    "47-panel dashboard covering sync status, vote delay, consensus events, system " +
    "resources, disk, network, txpool, raptorcast traffic, and 20+ error categories. " +
    "Auto-installer handles UFW, chrony, hostmetrics overlay, healthcheck. Loopback-only " +
    "by default for security; --public flag exposes Grafana :3000 if you want it " +
    "reachable from outside the host.",
  highlights: [
    '47-panel dashboard, datasource-templated — works with multiple Prometheus instances',
    'Auto-detects otelcol (core) vs otelcol-contrib at runtime',
    'No hardcoded NVMe/NIC device names — adapts to your host',
    '~95 MB RAM, ~0.1% CPU — designed not to interfere with the Monad node itself',
    'Container logs rotated (json-file 10 MB × 3) — won\'t fill disk',
    'Healthcheck script for cron or CI: `/opt/monad-grafana/scripts/healthcheck.sh`',
  ],
  components: [
    {
      name: 'prometheus',
      port: '9090 (loopback)',
      image: 'prom/prometheus:v2.55.0',
      purpose: 'Scrapes Monad otelcol :8889 + sidecar RPC exporter. 30 days / 10 GB retention.',
    },
    {
      name: 'grafana',
      port: '3000 (loopback, or 0.0.0.0 with --public)',
      image: 'grafana/grafana:11.3.0',
      purpose: 'Renders the 47-panel dashboard. Prometheus pre-provisioned as default datasource.',
    },
    {
      name: 'monad-rpc-exporter',
      port: '9101 (loopback)',
      image: 'python:3.12-alpine',
      purpose: 'Stdlib-only Python sidecar (no pip deps). Polls JSON-RPC for block height + sync gap, reads /proc for service uptime. Runs as nobody (uid 65534).',
    },
    {
      name: 'node-exporter',
      port: '9100 (loopback)',
      image: 'prom/node-exporter:v1.8.2',
      purpose: 'Standard Prometheus host metrics — CPU, RAM, disk, network. Complements otelcol\'s monad_* metrics.',
    },
  ],
  rawUrl: `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/install.sh`,
  githubUrl: `https://github.com/${REPO_OWNER}/${REPO_NAME}`,
  readmeUrl: `https://github.com/${REPO_OWNER}/${REPO_NAME}#readme`,
  installCmd: `curl -fsSL https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/install.sh | sudo bash`,
  installCmdManual: `git clone https://github.com/${REPO_OWNER}/${REPO_NAME}.git\ncd ${REPO_NAME}\nless install.sh           # review before running\nsudo ./install.sh`,
  upgradeCmd: 'sudo /opt/monad-grafana/install.sh --upgrade',
  uninstallCmd: 'sudo /opt/monad-grafana/install.sh --uninstall',
  healthcheckCmd: '/opt/monad-grafana/scripts/healthcheck.sh',
  enableHostmetricsCmd: 'sudo /opt/monad-grafana/install.sh --enable-hostmetrics',
};

interface CacheEntry {
  data: MonitoringCatalogResponse;
  fetchedAt: number;
}
const g = globalThis as { __monitoringCatalogCache__?: CacheEntry };

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

async function buildCatalog(): Promise<MonitoringCatalogResponse> {
  const apiBase = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;

  const [repoMeta, latestCommit] = await Promise.all([
    fetchGitHub<GhRepo>(apiBase),
    fetchGitHub<GhCommit[]>(`${apiBase}/commits?per_page=1&sha=${REPO_BRANCH}`),
  ]);

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
    stack: STATIC_STACK,
    fetchedAt: Date.now(),
    cacheAgeSeconds: 0,
  };
}

export async function getMonitoringCatalog(): Promise<MonitoringCatalogResponse> {
  const now = Date.now();
  const cached = g.__monitoringCatalogCache__;
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return {
      ...cached.data,
      cacheAgeSeconds: Math.floor((now - cached.fetchedAt) / 1000),
    };
  }
  const fresh = await buildCatalog();
  g.__monitoringCatalogCache__ = { data: fresh, fetchedAt: now };
  return fresh;
}
