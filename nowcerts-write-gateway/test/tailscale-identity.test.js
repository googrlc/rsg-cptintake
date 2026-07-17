import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAddress,
  Role,
  StaticIdentityResolver,
  TailscaleIdentityResolver,
} from "../src/auth/tailscale-identity.js";

test("normalizeAddress strips IPv4-mapped IPv6 prefix and port", () => {
  assert.equal(normalizeAddress("::ffff:100.64.0.5"), "100.64.0.5");
  assert.equal(normalizeAddress("100.64.0.5:52344"), "100.64.0.5");
  assert.equal(normalizeAddress("100.64.0.5"), "100.64.0.5");
  assert.equal(normalizeAddress(""), null);
});

test("static resolver maps a source IP to an identity", async () => {
  const resolver = new StaticIdentityResolver({
    "100.64.0.5": { actor: "lamar", role: Role.ADMIN, tailnet_user: "lamar@risksolutionsgroup.net" },
  });
  assert.deepEqual(await resolver.resolve("::ffff:100.64.0.5"), {
    actor: "lamar",
    role: Role.ADMIN,
    tailnet_user: "lamar@risksolutionsgroup.net",
  });
  assert.equal(await resolver.resolve("100.64.0.9"), null);
});

test("tailscale resolver derives actor+role from an injected whois result", async () => {
  const whois = async (addr) =>
    addr === "100.64.0.7" ? { UserProfile: { LoginName: "gretchen@risksolutionsgroup.net" } } : null;
  const resolver = new TailscaleIdentityResolver({
    userMap: {
      "lamar@risksolutionsgroup.net": { actor: "lamar", role: Role.ADMIN },
      "gretchen@risksolutionsgroup.net": { actor: "gretchen", role: Role.OPERATOR },
    },
    whois,
  });
  assert.deepEqual(await resolver.resolve("100.64.0.7"), {
    actor: "gretchen",
    role: Role.OPERATOR,
    tailnet_user: "gretchen@risksolutionsgroup.net",
  });
});

test("tailscale resolver returns null for a tailnet user who is not authorized", async () => {
  const whois = async () => ({ UserProfile: { LoginName: "intern@risksolutionsgroup.net" } });
  const resolver = new TailscaleIdentityResolver({
    userMap: { "lamar@risksolutionsgroup.net": { actor: "lamar", role: Role.ADMIN } },
    whois,
  });
  assert.equal(await resolver.resolve("100.64.0.20"), null);
});

test("tailscale resolver returns null when whois cannot identify the device", async () => {
  const resolver = new TailscaleIdentityResolver({ userMap: {}, whois: async () => null });
  assert.equal(await resolver.resolve("100.64.0.99"), null);
});

test("live whois is not wired off-host and fails loudly rather than guessing", async () => {
  const resolver = new TailscaleIdentityResolver({ userMap: {} });
  await assert.rejects(() => resolver.resolve("100.64.0.1"), /not wired/);
});
