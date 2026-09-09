import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {persistentBootstrap} from '../src/connection-pool.js';
import {buildRemoteDaemon} from '../src/remote-runner.js';

test('short bootstrap preserves byte framing and multiple daemon requests', () => {
  const source='# '+('中文'.repeat(5000))+'\n'+buildRemoteDaemon();
  const bootstrap=persistentBootstrap({remotePython:'python',sshFlavor:'openssh'},source);
  assert.ok(bootstrap.command.length < 1000);
  assert.ok(bootstrap.body.length > 8191);
  const code=bootstrap.command.match(/-c "(.*)"$/u)[1];
  const frames=['first','second'].map(id=>JSON.stringify({id,payload:{operation:'probe_identity'}})+'\n').join('');
  const result=spawnSync('python',['-u','-X','utf8','-c',code],{input:Buffer.concat([bootstrap.body,Buffer.from(frames)]),timeout:20000});
  assert.equal(result.status,0,result.stderr?.toString());
  const responses=result.stdout.toString('utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(new Set(responses.map(x=>x.id)),new Set(['first','second']));
  assert.ok(responses.every(x=>x.ok && x.result.hostname));
});
