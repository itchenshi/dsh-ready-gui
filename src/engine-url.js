"use strict";

/**
 * Engine-URL trust checks for the desktop shell.
 *
 * The engine child's stdout is not a trusted channel: the engine process hosts
 * third-party plugins (each with a host half) that can print their own
 * `dsh web: <anything>` line before the real server announces itself. The main
 * window also carries the workspace preload bridge (restart the engine, read/write
 * the last-session pointer), so loading an attacker-chosen origin there would hand
 * that bridge to a remote page.
 *
 * `acceptableEngineUrl` therefore accepts only an `http:` URL whose host is a
 * loopback/private **IP literal** (or `localhost`): a domain name is always
 * refused, even one that looks local. The port is whatever the engine picked for
 * `--port 0`, so it is not validated here.
 */

/** Parse an IPv4 literal into four octets, or return null. */
function ipv4Octets(host) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) return null;
  const octets = host.split(".").map((part) => Number(part));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return octets;
}

/** True for loopback, RFC1918 private and link-local IPv4 ranges. */
function isLocalIpv4(octets) {
  const [a, b] = octets;
  return (
    a === 127 || // loopback
    a === 10 || // 10/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 169 && b === 254) // link-local
  );
}

/**
 * @param {unknown} raw - the URL announced by the engine child.
 * @returns {URL|null} the parsed URL when it is a trusted local http origin.
 */
function acceptableEngineUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (host === "localhost" || host === "::1") return url;
  const octets = ipv4Octets(host);
  if (octets === null) return null;
  return isLocalIpv4(octets) ? url : null;
}

/** Two URLs share an origin (a URL that cannot be parsed never matches). */
function sameOrigin(candidate, origin) {
  try {
    return new URL(String(candidate)).origin === origin;
  } catch {
    return false;
  }
}

module.exports = { acceptableEngineUrl, sameOrigin, isLocalIpv4, ipv4Octets };
