import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

for (const [name, version] of [['seroval', '1.6.9'], ['source-map-js', '1.2.2']]) {
  test(`${name} retains the reviewed fixed version and registry integrity`, () => {
    const entry = lock.packages[`node_modules/${name}`];
    assert.equal(entry.version, version);
    assert.equal(entry.resolved, `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`);
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+=*$/u);
  });
}

test('the application CI rejects high and critical advisories before the build', () => {
  const audit = workflow.indexOf('run: npm audit --omit=dev --audit-level=high');
  const app = workflow.indexOf('  app:');
  const build = workflow.indexOf('      - name: Build', app);
  assert.ok(audit > app && audit < build);
  assert.ok(!workflow.slice(app, build).includes('continue-on-error'));
  assert.ok(!workflow.slice(app, build).includes('npm audit --omit=dev --audit-level=high ||'));
});
