import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuntimeClientId, resolveDaemonPaths } from '../src/config.js';

test('getRuntimeClientId prefers explicit client env over heuristics', () => {
  assert.equal(
    getRuntimeClientId({ ECHOCODING_CLIENT: 'claude', CODEX_THREAD_ID: 'abc' }),
    'claude',
  );
  assert.equal(
    getRuntimeClientId({ ECHOCODING_HOOK_CLIENT: 'codex' }),
    'codex',
  );
  assert.equal(
    getRuntimeClientId({ ECHOCODING_CLIENT: 'default', CODEX_THREAD_ID: 'abc' }),
    'default',
  );
});

test('getRuntimeClientId falls back to codex heuristic and default', () => {
  assert.equal(getRuntimeClientId({ CODEX_THREAD_ID: 'thread-1' }), 'codex');
  assert.equal(getRuntimeClientId({}), 'default');
});

test('resolveDaemonPaths appends client suffix to socket, log, and pid files', () => {
  const base = {
    socketPath: '/tmp/echocoding.sock',
    logFile: '/home/dev/.echocoding/logs/daemon.log',
    pidFile: '/home/dev/.echocoding/daemon.pid',
  };

  const codex = resolveDaemonPaths(base, 'codex');
  assert.equal(codex.socketPath, '/tmp/echocoding.codex.sock');
  assert.equal(codex.logFile, '/home/dev/.echocoding/logs/daemon.codex.log');
  assert.equal(codex.pidFile, '/home/dev/.echocoding/daemon.codex.pid');

  const def = resolveDaemonPaths(base, 'default');
  assert.equal(def.socketPath, base.socketPath);
  assert.equal(def.logFile, base.logFile);
  assert.equal(def.pidFile, base.pidFile);
});
