import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
// @ts-expect-error — plain JS module without type declarations
import { isBannedPackage, scan } from '../../scripts/check-no-ai.js';

const dirs: string[] = [];
function project(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'no-ai-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
  return dir;
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const pkg = (deps: Record<string, string> = {}) => JSON.stringify({ name: 'x', dependencies: { express: '^4', ...deps } });
// Built from fragments so the repo-wide scan doesn't flag this test file
const ai = (...p: string[]) => p.join('');

describe('isBannedPackage', () => {
  it.each([ai('open', 'ai'), ai('@anthropic-ai/', 'sdk'), ai('a', 'i'), ai('@mistral', 'ai/mistralai'), ai('@lang', 'chain/core'), ai('tesseract', '.js')])(
    'bans %s',
    (n) => expect(isBannedPackage(n)).toBe(true),
  );
  it.each(['express', 'aimless', 'openapi-types', '@aws-sdk/client-s3', 'airbnb'])('allows %s', (n) => expect(isBannedPackage(n)).toBe(false));
});

describe('scan', () => {
  it('passes a clean project', () => {
    expect(scan(project({ 'package.json': pkg(), 'src/a.ts': "import express from 'express';\n" }))).toEqual([]);
  });

  it('flags a banned dependency in package.json', () => {
    const f = scan(project({ 'package.json': pkg({ [ai('open', 'ai')]: '^4' }) }));
    expect(f.join('\n')).toMatch(/banned package/);
  });

  it('flags a banned package in the lockfile (transitive)', () => {
    const lock = JSON.stringify({ packages: { [`node_modules/foo/node_modules/${ai('cohere', '-ai')}`]: {} } });
    expect(scan(project({ 'package.json': pkg(), 'package-lock.json': lock })).join('\n')).toMatch(/lockfile/);
  });

  it('flags a banned import in source', () => {
    const f = scan(project({ 'package.json': pkg(), 'src/x.ts': `import Anthropic from '${ai('@anthropic-ai/', 'sdk')}';\n` }));
    expect(f.join('\n')).toMatch(/src\/x\.ts:1 .*imports banned package/);
  });

  it('flags a banned env var in source and in .env.example', () => {
    const v = ai('OPEN', 'AI_API_KEY');
    const f = scan(project({ 'package.json': pkg(), 'src/y.ts': `const k = process.env.${v};\n`, '.env.example': `${v}=\n` }));
    expect(f).toHaveLength(2);
  });

  it('ignores node_modules and dist', () => {
    const f = scan(project({ 'package.json': pkg(), [`node_modules/z/index.js`]: `require('${ai('open', 'ai')}')`, 'dist/a.js': `${ai('GEM', 'INI_')}KEY` }));
    expect(f).toEqual([]);
  });

  it('passes on this repository', () => {
    expect(scan(path.resolve('.'))).toEqual([]);
  });
});
