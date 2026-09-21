"use strict";

// Guards the "engine stdout must not be able to hand the privileged main window to
// a remote origin" rule (see src/engine-url.js). Run: node src/test/engine-url.test.cjs
const assert = require("node:assert/strict");
const { acceptableEngineUrl, sameOrigin, isLocalIpv4, ipv4Octets } = require("../engine-url.js");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("  ok - " + name);
  } catch (error) {
    failures += 1;
    console.error("  ✗ " + name + "\n      " + (error && error.message));
  }
}

const ok = (raw, expected) => {
  const url = acceptableEngineUrl(raw);
  assert.notEqual(url, null, `expected ${raw} to be accepted`);
  if (expected) assert.equal(url.origin, expected, `origin of ${raw}`);
};
const bad = (raw) => assert.equal(acceptableEngineUrl(raw), null, `expected ${raw} to be refused`);

check("accepts the loopback URL the shell itself launches", () => {
  ok("http://127.0.0.1:51234/?token=abc", "http://127.0.0.1:51234");
  ok("http://localhost:3000/", "http://localhost:3000");
  ok("http://[::1]:8080/x", "http://[::1]:8080");
  ok("http://127.0.0.1:1/");
});

check("accepts private/LAN literals (engine may be bound to a LAN address)", () => {
  for (const host of ["10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.20", "169.254.3.4"]) {
    ok(`http://${host}:9000/`);
  }
  assert.equal(isLocalIpv4(ipv4Octets("172.32.0.1")), false, "172.32/12 is not private");
});

check("refuses remote origins and every non-http scheme", () => {
  bad("https://attacker.example/");
  bad("http://attacker.example/");
  bad("http://8.8.8.8:80/");
  bad("http://1.1.1.1/");
  bad("file:///C:/Windows/System32/drivers/etc/hosts");
  bad("javascript:alert(1)");
  bad("data:text/html,<script>1</script>");
  bad("ftp://127.0.0.1/");
  bad("");
  bad(null);
  bad(undefined);
  bad("not a url");
});

check("refuses a loopback literal smuggled into the userinfo", () => {
  // new URL() reports hostname evil.example for this, but pin the behaviour: a
  // future refactor that reads the raw string must not accept it either.
  bad("http://192.168.1.1:80@evil.example/");
  bad("http://127.0.0.1@evil.example/");
  assert.equal(new URL("http://127.0.0.1@evil.example/").hostname, "evil.example");
});

check("refuses genuinely malformed IPv4", () => {
  bad("http://999.1.1.1/");
  bad("http://127.0.0.256/");
  bad("http://127.0.0.1.5/");
});

check("shorthand literals are accepted only because the parser normalises them to loopback", () => {
  // The WHATWG URL parser canonicalises these to 127.x before we ever see them, so
  // they stay local — which is exactly why the check runs on the parsed hostname
  // instead of pattern-matching the raw string. Pinned so a future refactor that
  // reads the raw input cannot accidentally start trusting a real remote host.
  assert.equal(new URL("http://127.0.0/").hostname, "127.0.0.0");
  assert.equal(new URL("http://2130706433/").hostname, "127.0.0.1");
  assert.equal(new URL("http://0x7f.1/").hostname, "127.0.0.1");
  ok("http://127.0.0/", "http://127.0.0.0");
  ok("http://2130706433/", "http://127.0.0.1");
});

check("sameOrigin compares origins, and never throws on garbage", () => {
  assert.equal(sameOrigin("http://127.0.0.1:5000/chat?x=1", "http://127.0.0.1:5000"), true);
  assert.equal(sameOrigin("http://127.0.0.1:5001/", "http://127.0.0.1:5000"), false);
  assert.equal(sameOrigin("https://127.0.0.1:5000/", "http://127.0.0.1:5000"), false);
  assert.equal(sameOrigin("not a url", "http://127.0.0.1:5000"), false);
  assert.equal(sameOrigin(null, "http://127.0.0.1:5000"), false);
});

if (failures > 0) {
  console.error(`\nengine-url: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nengine-url: all checks passed");
