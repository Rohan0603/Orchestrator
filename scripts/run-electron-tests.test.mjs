import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRun } from "./run-electron-tests.mjs";

test("runner rejects success markers when child hangs", () => {
  assert.equal(
    evaluateRun({ exitCode: null, resultCount: 1, expected: 1, timedOut: true }),
    false
  );
});

test("runner rejects success markers when child exits nonzero", () => {
  assert.equal(
    evaluateRun({ exitCode: 1, resultCount: 1, expected: 1 }),
    false
  );
});

test("runner accepts matching clean child exit", () => {
  assert.equal(
    evaluateRun({ exitCode: 0, resultCount: 1, expected: 1 }),
    true
  );
});
