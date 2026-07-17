// Identity resolution for the Tailscale-only deployment (plan §5, Option A).
// There is no login: access is gated by tailnet membership, and the acting user
// (Lamar = admin, Gretchen = operator) is derived from *which device* is
// calling — the request's source IP resolved through Tailscale `whois`. The
// gateway then trusts this resolved identity instead of a caller-supplied
// `actor`/`approver` field, so the least-privilege split in policy.js cannot be
// spoofed by anyone on the tailnet.
//
// Matches the other seams in this repo: an interface, an offline stub for tests,
// and a live resolver whose external call (the Tailscale LocalAPI) is injectable
// so it can be exercised offline and only wired for real on the tailnet host.
//
// @typedef {{ resolve(remoteAddress: string): Promise<{actor: string, role: string, tailnet_user: string}|null> }} IdentityResolver

export const Role = { ADMIN: "admin", OPERATOR: "operator" };

// Normalize a Node socket remote address to a bare IP: strip an IPv4-mapped
// IPv6 prefix and any trailing :port. Returns null for empty input.
export function normalizeAddress(address) {
  if (!address) return null;
  let addr = String(address).trim();
  addr = addr.replace(/^::ffff:/i, "");
  const ipv4WithPort = addr.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+$/);
  if (ipv4WithPort) addr = ipv4WithPort[1];
  return addr || null;
}

// Offline stub: a fixed source-IP -> identity table. Used by tests and any
// shadow run where the tailnet LocalAPI is not available.
export class StaticIdentityResolver {
  constructor(map = {}) {
    // map: { "100.x.y.z": { actor: "lamar", role: Role.ADMIN, tailnet_user: "lamar@..." } }
    this.map = new Map(Object.entries(map));
  }

  async resolve(remoteAddress) {
    const addr = normalizeAddress(remoteAddress);
    return (addr && this.map.get(addr)) || null;
  }
}

// Live resolver. `whois` is injected so the LocalAPI dependency is testable and
// so the default (which requires the Tailscale daemon) never runs off-host.
// Real wiring on the tailnet host: call the Tailscale LocalAPI
//   GET /localapi/v0/whois?addr=<ip>
// over its local unix socket / 127.0.0.1 endpoint and read UserProfile.LoginName.
export class TailscaleIdentityResolver {
  /**
   * @param {object} options
   * @param {Record<string,{actor:string,role:string}>} options.userMap tailnet login -> identity
   * @param {(addr: string) => Promise<{UserProfile?: {LoginName?: string}}|null>} [options.whois]
   */
  constructor({ userMap = {}, whois } = {}) {
    this.userMap = new Map(Object.entries(userMap));
    this.whois = whois ?? notWired;
  }

  async resolve(remoteAddress) {
    const addr = normalizeAddress(remoteAddress);
    if (!addr) return null;
    const info = await this.whois(addr);
    const login = info?.UserProfile?.LoginName;
    if (!login) return null; // unknown device / not a tailnet user
    const mapped = this.userMap.get(login);
    if (!mapped) return null; // authenticated tailnet user, but not an authorized operator
    return { actor: mapped.actor, role: mapped.role, tailnet_user: login };
  }
}

function notWired() {
  throw new Error(
    "Tailscale LocalAPI whois is not wired in this build. Run on the tailnet host and inject a whois() that queries /localapi/v0/whois.",
  );
}
