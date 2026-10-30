import assert from "node:assert/strict";
import { checkGuard, parseNeonUrl } from "../src/lib/predeploy-guard";

const PROD = "ep-muddy-mode-b56ut3r5", DEV = "ep-shy-wave-b5isaje3", REI = "ep-cool-dust-a1b2c3d4";
const url = (ep: string, pooler = false) => `postgresql://u:secret@${ep}${pooler ? "-pooler" : ""}.us-east-2.aws.neon.tech/neondb?sslmode=require`;
const allow = { prod: PROD, dev: DEV };

const p = parseNeonUrl(url(PROD, true));
assert.ok(!("error" in p) && p.endpoint === PROD && p.database === "neondb", "pooler suffix stripped");

assert.equal(checkGuard({ target: "prod", directUrl: url(PROD), allow }).ok, true);
assert.equal(checkGuard({ target: "dev", directUrl: url(DEV), databaseUrl: url(DEV, true), allow }).ok, true);

const bad = (i: Parameters<typeof checkGuard>[0], re: RegExp) => {
  const r = checkGuard(i);
  assert.ok(!r.ok && re.test(r.reason), `expected refusal ${re}, got ${JSON.stringify(r)}`);
};
bad({ target: "prod", directUrl: url(REI), allow }, /not in the allowlist/);           // the incident: another project
bad({ target: "prod", directUrl: url(DEV), allow }, /DEV endpoint/);                  // dev URL while targeting prod
bad({ target: "dev", directUrl: url(PROD), allow }, /PROD endpoint/);
bad({ target: "prod", directUrl: url(PROD), allow: { dev: DEV } }, /YUMMY_PROD_ENDPOINT is not set/);
bad({ target: "prod", directUrl: url(PROD), allow: { prod: "", dev: DEV } }, /not set/);
bad({ target: undefined, directUrl: url(PROD), allow }, /--target/);
bad({ target: "staging", directUrl: url(PROD), allow }, /--target/);
bad({ target: "prod", directUrl: undefined, allow }, /not set/);
bad({ target: "prod", directUrl: "postgresql://u:p@localhost:5432/db", allow }, /not a Neon host/);
bad({ target: "prod", directUrl: url(PROD), databaseUrl: url(REI, true), allow }, /DATABASE_URL points at/);
bad({ target: "prod", directUrl: url(PROD), allow: { prod: PROD, dev: PROD } }, /identical/);
bad({ target: "prod", directUrl: url(PROD), allow: { prod: `${PROD}.us-east-2.aws.neon.tech` } }, /must look like/);
// case-insensitive, whitespace tolerant
assert.equal(checkGuard({ target: "prod", directUrl: url(PROD), allow: { prod: ` ${PROD.toUpperCase()} ` } }).ok, true);
// never echoes the password
const r = checkGuard({ target: "prod", directUrl: url(REI), allow });
assert.ok(!JSON.stringify(r).includes("secret"));
console.log("predeploy guard: all checks passed");
