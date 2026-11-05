'use strict';
const assert = require('assert');
const { isPrivate, norm, claim, normGuide, toText, server } = require('./server');
assert(isPrivate('127.0.0.1') && isPrivate('10.1.2.3') && isPrivate('192.168.0.1') && isPrivate('::1') && isPrivate('::ffff:127.0.0.1'));
assert(!isPrivate('8.8.8.8') && !isPrivate('172.32.0.1'));
assert.strictEqual(norm('  A\u2019s   B '), "a's b");
assert.strictEqual(claim(['x', 'bogus']).evidence, 'unverified');
assert.strictEqual(toText('<p>Hi&nbsp;<b>there</b></p><script>x()</script>'), 'Hi there');
const g = normGuide({ name: 'T', difficulty: 'weird', steps: [['a', 'reviewed']], sources: [{ url: 'javascript:1' }, { url: 'https://x.com/a', title: 'ok' }] }, 'curated');
assert.strictEqual(g.difficulty, 'Unknown'); assert.strictEqual(g.sources.length, 1);
server.listen(0, async () => {
  const base = 'http://localhost:' + server.address().port;
  try {
    const gs = await (await fetch(base + '/api/guides')).json();
    assert(gs.length >= 4);
    assert.strictEqual((await fetch(base + '/api/guides/google')).status, 200);
    assert.strictEqual((await fetch(base + '/api/guides/nope')).status, 404);
    assert.strictEqual((await fetch(base + '/g/google')).status, 200);
    assert.strictEqual((await fetch(base + '/../server.js')).status, 404);
    assert.strictEqual((await fetch(base + '/api/generate', { method: 'POST', body: '{"query":"x"}' })).status, process.env.LLM_API_KEY ? 200 : 503);
    console.log('All tests passed');
  } catch (e) { console.error(e); process.exitCode = 1; } finally { server.close(); }
});
