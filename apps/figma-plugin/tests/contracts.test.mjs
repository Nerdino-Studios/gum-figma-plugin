import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/transport/contracts.ts';

const vectors = JSON.parse(readFileSync(new URL('../../../schemas/contract-vectors.json', import.meta.url), 'utf8'));
for (const vector of vectors) {
  test(`wire contract: ${vector.name}`, () => {
    assert.equal(validateContract(vector.kind, vector.value), vector.valid);
  });
}
