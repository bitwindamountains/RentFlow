import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';

const shellPath = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const posix = path => path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);

for (const failure of ['', 'dump', 'uploads']) {
  test(failure ? `failed ${failure} leaves no published backup` : 'publishes both validated archives after success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rentflow-backup-test-'));
    try {
      const bin = join(root, 'bin');
      const output = join(root, 'output');
      await mkdir(bin);
      const fixture = join(root, 'uploads.gz');
      await writeFile(fixture, gzipSync(Buffer.from('upload archive fixture')));
      await writeFile(join(bin, 'docker'), `#!/bin/sh
case "$*" in *'--env-file .env.production'*) ;; *) exit 20;; esac
case "$*" in
  *pg_dump*) [ "$BACKUP_TEST_FAIL" != dump ] || exit 21; printf 'PGDMP fixture';;
  *'--entrypoint tar'*) [ "$BACKUP_TEST_FAIL" != uploads ] || exit 22; cat "$BACKUP_TEST_FIXTURE";;
  *) exit 23;;
esac
`, { mode: 0o700 });
      const result = spawnSync(shellPath, ['-c', 'PATH="$1:$PATH"; export PATH; exec sh "$2" "$3"', 'backup-test', posix(bin), posix(resolve('deploy/backup.sh')), posix(output)], {
        env: { ...process.env, BACKUP_TEST_FAIL: failure, BACKUP_TEST_FIXTURE: posix(fixture) }, encoding: 'utf8', timeout: 30_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, failure === 'dump' ? 21 : failure === 'uploads' ? 22 : 0, result.stderr);
      const files = await readdir(output);
      if (failure) {
        assert.notEqual(result.status, 0);
        assert.deepEqual(files, []);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(files.length, 2);
        const dump = files.find(name => name.endsWith('.dump.gz'));
        const uploads = files.find(name => name.endsWith('.tar.gz'));
        assert.equal(gunzipSync(await readFile(join(output, dump))).toString(), 'PGDMP fixture');
        assert.equal(gunzipSync(await readFile(join(output, uploads))).toString(), 'upload archive fixture');
      }
    } finally {
      assert.equal(dirname(resolve(root)), resolve(tmpdir()));
      assert.ok(basename(root).startsWith('rentflow-backup-test-'));
      await rm(root, { recursive: true, force: true });
    }
  });
}
