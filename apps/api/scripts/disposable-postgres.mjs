import EmbeddedPostgres from 'embedded-postgres';
import { createRequire } from 'node:module';

// embedded-postgres's async-exit-hook installs beforeExit => process.exit(0),
// overwriting a test runner's failure status. Its synchronous exit handler also
// calls async cleanup without a callback. These callers own cleanup in their
// teardown/finally blocks. Keep the package's signal handlers for interruptions.
const requireFromPostgres = createRequire(createRequire(import.meta.url).resolve('embedded-postgres'));
const exitHook = requireFromPostgres('async-exit-hook');
exitHook.unhookEvent('beforeExit');
exitHook.unhookEvent('exit');

export default EmbeddedPostgres;
