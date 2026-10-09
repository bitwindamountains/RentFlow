import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

for (const code of [0, 23]) {
  test(`disposable database import preserves process exit status ${code}`, () => {
    const moduleUrl = new URL('./disposable-postgres.mjs', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval',
      `await import(${JSON.stringify(moduleUrl)}); process.exitCode = ${code};`],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    assert.ifError(result.error);
    assert.equal(result.status, code, result.stderr);
    assert.equal(result.stderr, '');
  });
}
