import test from "node:test";
import assert from "node:assert/strict";
import { parseLasText } from "../../parsers/ParseLas.js";

const LAS_FIXTURE = `
~Version
VERS. 2.0
~Well
NULL. -999.25
~Curve
DEPTH.M : Track # 0
TIME.S : Track # 1
HC1.UNKN : Track # 2
HC2.UNKN : Track # 3
~Ascii
1000 1 10 20
1001 2 11 21
1002 3 12 22
`;

test("parseLasText removes TIME curve from exported curves", () => {
  const parsed = parseLasText(LAS_FIXTURE);
  const ids = parsed.curves.map((c) => c.id);
  assert.equal(ids.includes("TIME__1"), false);
  assert.deepEqual(ids, ["DEPTH__0", "HC1__2", "HC2__3"]);
});

test("parseLasText rows stay depth sorted and omit TIME values", () => {
  const parsed = parseLasText(LAS_FIXTURE);
  assert.equal(parsed.rows.length, 3);
  for (let i = 1; i < parsed.rows.length; i += 1) {
    assert.ok(parsed.rows[i].depth >= parsed.rows[i - 1].depth);
  }
  assert.equal(parsed.rows[0].curves.TIME__1, undefined);
  assert.equal(parsed.rows[0].curves.HC1__2, 10);
  assert.equal(parsed.rows[0].curves.HC2__3, 20);
});

