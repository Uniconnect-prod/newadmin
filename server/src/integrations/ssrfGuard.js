import dns from 'dns';
import net from 'net';
import { IntegrationError } from './errors.js';

/**
 * Server-side request forgery protection for admin-configurable platform API URLs.
 *
 *  1. URL policy: https only (http only for explicitly listed dev hosts), no credentials,
 *     default ports unless the allow-list entry names a port, no IP literals unless
 *     explicitly allowed.
 *  2. Host approval: the hostname must match an approved host (env OUTBOUND_ALLOWED_HOSTS
 *     or the Super Admin managed allow-list).
 *  3. Address policy: every DNS answer is checked; loopback, private, link-local, CGNAT,
 *     multicast, reserved and cloud-metadata destinations are blocked. The validated
 *     address is the one the socket connects to (no DNS-rebinding window).
 *  4. Redirects are re-validated hop by hop by the HTTP client using the same policy.
 */

const blockList = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
].forEach(([addr, prefix]) => blockList.addSubnet(addr, prefix, 'ipv4'));
[
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
  ['2001:db8::', 32], ['100::', 64], ['2001::', 32]
].forEach(([addr, prefix]) => blockList.addSubnet(addr, prefix, 'ipv6'));

const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data', 'instance-data.ec2.internal',
  'kubernetes.default', 'kubernetes.default.svc'
]);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa', '.svc', '.cluster.local'];

export function expandIPv6(ip) {
  let addr = String(ip).toLowerCase().split('%')[0];
  let tail = [];
  const v4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    if (o.some(x => x > 255)) return null;
    tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    addr = addr.slice(0, -v4[1].length);
    if (addr.endsWith(':') && !addr.endsWith('::')) addr = addr.slice(0, -1);
  }
  const parts = addr.split('::');
  if (parts.length > 2) return null;
  const parse = s => (s ? s.split(':').map(x => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN)) : []);
  const head = parse(parts[0]);
  const rest = parts.length === 2 ? parse(parts[1]) : null;
  let groups;
  if (rest === null) {
    groups = head;
  } else {
    const fill = 8 - tail.length - head.length - rest.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array(fill).fill(0), ...rest];
  }
  groups = [...groups, ...tail];
  if (groups.length !== 8 || groups.some(g => Number.isNaN(g))) return null;
  return groups;
}

function embeddedIPv4(groups) {
  const toV4 = (a, b) => `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible)
  if (groups.slice(0, 5).every(g => g === 0) && (groups[5] === 0xffff || groups[5] === 0)) return toV4(groups[6], groups[7]);
  // 64:ff9b::/96 NAT64
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every(g => g === 0)) return toV4(groups[6], groups[7]);
  // 2002::/16 6to4
  if (groups[0] === 0x2002) return toV4(groups[1], groups[2]);
  return null;
}

export function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return blockList.check(ip, 'ipv4');
  if (family === 6) {
    const groups = expandIPv6(ip);
    if (!groups) return true;
    const v4 = embeddedIPv4(groups);
    if (v4 && blockList.check(v4, 'ipv4')) return true;
    return blockList.check(ip, 'ipv6');
  }
  return true; // not an IP at all: treat as unsafe
}

export function isBlockedHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  return BLOCKED_SUFFIXES.some(s => h.endsWith(s));
}

/**
 * Allow-list entries: "api.example.com", "*.example.com", "api.example.com:8443", "127.0.0.1:5055".
 */
export function hostMatches(entry, hostname, port) {
  const [patternHost, patternPort] = String(entry).toLowerCase().trim().split(/:(?=\d+$)/);
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (patternPort && String(port) !== patternPort) return false;
  if (patternHost === '*' || patternHost === '*:*') return true;
  if (patternHost.startsWith('*.')) {
    const suffix = patternHost.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === patternHost.replace(/^\[|\]$/g, '');
}

export function normalizeAllowlistEntry(entry) {
  const value = String(entry || '').trim().toLowerCase();
  if (!value) return null;
  if (value === '*' || value === '*:*') return value;
  if (!/^(\*\.)?[a-z0-9.-]+(:\d{1,5})?$/.test(value) && !/^\[?[0-9a-f:.]+\]?(:\d{1,5})?$/.test(value)) return null;
  return value;
}

function effectivePort(url) {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

/**
 * Validate a URL against the outbound policy. Returns the parsed URL and per-destination
 * flags used by the guarded DNS lookup.
 */
export function checkUrlPolicy(rawUrl, policy) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new IntegrationError('INVALID_URL');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const port = effectivePort(url);
  const listed = list => (list || []).some(e => hostMatches(e, hostname, port));

  if (url.username || url.password) throw new IntegrationError('INVALID_URL', 'Credentials in URLs are not allowed.');
  if (url.protocol !== 'https:') {
    if (!(url.protocol === 'http:' && listed(policy.allowHttpHosts))) {
      throw new IntegrationError('BLOCKED_DESTINATION', 'Only HTTPS URLs are allowed.');
    }
  }

  const privateException = listed(policy.allowPrivateHosts);
  if (!privateException) {
    if (isBlockedHostname(hostname)) throw new IntegrationError('BLOCKED_DESTINATION', `Host '${hostname}' is not a public hostname.`);
    if (net.isIP(hostname)) {
      if (isPrivateAddress(hostname)) throw new IntegrationError('BLOCKED_DESTINATION', 'Private, loopback and metadata addresses are blocked.');
      if (!listed(policy.allowedHosts)) throw new IntegrationError('HOST_NOT_APPROVED', `IP address ${hostname} is not on the approved host list.`);
    }
    const defaultPort = url.protocol === 'https:' ? 443 : 80;
    const hasWildcard = (policy.allowedHosts || []).some(e => e === '*' || e === '*:*');
    if (port !== defaultPort && !hasWildcard && !(policy.allowedHosts || []).some(e => /:\d+$/.test(e) && hostMatches(e, hostname, port))) {
      throw new IntegrationError('BLOCKED_DESTINATION', `Non-standard port ${port} must be approved explicitly as ${hostname}:${port}.`);
    }
  }

  if (!privateException && !listed(policy.allowedHosts)) {
    throw new IntegrationError('HOST_NOT_APPROVED', `Host '${hostname}' is not on the approved outbound host list.`);
  }

  return { url, hostname, port, allowPrivate: privateException };
}

/**
 * DNS lookup used by the HTTP client socket. Rejects the connection if ANY resolved
 * address is private/reserved (unless the destination is an explicit private exception).
 */
export function createGuardedLookup({ allowPrivate = false, resolver = dns.lookup } = {}) {
  return function guardedLookup(hostname, options, callback) {
    const opts = typeof options === 'function' ? {} : (options || {});
    const cb = typeof options === 'function' ? options : callback;
    resolver(hostname, { all: true, family: opts.family || 0 }, (err, addresses) => {
      if (err) return cb(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }];
      if (!list.length) return cb(Object.assign(new Error(`No addresses for ${hostname}`), { code: 'ENOTFOUND' }));
      if (!allowPrivate) {
        const bad = list.find(a => isPrivateAddress(a.address));
        if (bad) {
          return cb(Object.assign(new Error(`Destination ${hostname} resolves to a blocked address.`), { code: 'EBLOCKEDDEST' }));
        }
      }
      if (opts.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };
}
