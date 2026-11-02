import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

for (const [name, version] of [['seroval', '1.6.9'], ['source-map-js', '1.2.2'], ['proxy-addr', '2.0.8']]) {
  test(`${name} retains the reviewed fixed version and registry integrity`, () => {
    const entry = lock.packages[`node_modules/${name}`];
    assert.equal(entry.version, version);
    assert.equal(entry.resolved, `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`);
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+=*$/u);
  });
}

test('the application CI reports advisories without suppressing scanner failures before the build', () => {
  const audit = workflow.indexOf('run: node scripts/vulnerability-report.mjs npm-production');
  const app = workflow.indexOf('  app:');
  const build = workflow.indexOf('      - name: Build', app);
  assert.ok(audit > app && audit < build);
  assert.ok(!workflow.slice(app, build).includes('continue-on-error'));
  assert.ok(!workflow.slice(app, build).includes('|| true'));
});

test('the deployer graph is scanned too and reports are retained even on failure', () => {
  const app = workflow.indexOf('  app:');
  const audit = workflow.indexOf('run: node scripts/vulnerability-report.mjs npm-development', app);
  const build = workflow.indexOf('      - name: Build', app);
  assert.ok(audit > app && audit < build);
  assert.ok(!workflow.slice(app, build).includes('continue-on-error'));
  assert.ok(workflow.slice(app, build).includes('if: always()'));
  assert.ok(workflow.slice(app, build).includes('retention-days: 90'));
  assert.ok(workflow.slice(app, build).includes('atrium-npm-vulnerabilities-node-${{ matrix.node-version }}'));
});

for (const image of ['frontend', 'bridge']) {
  test(`${image} findings do not block CI but scanner errors and malformed reports still do`, () => {
    const job = workflow.slice(workflow.indexOf(`  ${image}-image:`),
      image === 'frontend' ? workflow.indexOf('  app:') : undefined);
    assert.match(job, /fail-build: false/);
    assert.match(job, /only-fixed: false/);
    assert.match(job, /output-format: json/);
    assert.ok(job.includes(`output-file: \${{ runner.temp }}/atrium-${image}-vulnerabilities.json`));
    assert.ok(job.includes(`node scripts/vulnerability-report.mjs grype "$RUNNER_TEMP/atrium-${image}-vulnerabilities.json"`));
    assert.ok(job.includes('if: always()'));
    assert.ok(job.includes('retention-days: 90'));
    assert.ok(!job.includes('continue-on-error'));
    assert.ok(!job.includes('|| true'));
  });
}
