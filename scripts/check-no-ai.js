#!/usr/bin/env node
// scripts/check-no-ai.js
//
// CI guard: Spendwise must never call an AI/LLM/OCR API itself — the user's
// own Claude does the reading. Fails (exit 1) if:
//   1. package.json or package-lock.json depends on a banned package, or
//   2. any source/config file imports a banned package or references an env
//      var matching /(OPENAI|ANTHROPIC|GEMINI|MISTRAL|COHERE)_/.
//
// Run with: node scripts/check-no-ai.js [rootDir]

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

// Exact package names, and scopes (ending in "/") whose every package is banned.
// Built from fragments so this file doesn't trip its own source scan.
const j = (...p) => p.join('');
export const BANNED_PACKAGES = [
  j('open', 'ai'),
  j('@anthropic-ai/', 'sdk'),
  j('@google/', 'generative-ai'),
  j('@google/', 'genai'),
  j('lang', 'chain'),
  j('@lang', 'chain/'),
  j('a', 'i'), // Vercel AI SDK
  j('@ai-', 'sdk/'),
  j('cohere', '-ai'),
  j('@mistral', 'ai/'),
  j('@google-cloud/', 'vision'),
  j('@aws-sdk/client-', 'textract'),
  j('@aws-sdk/client-', 'rekognition'),
  j('@azure/ai-', 'form-recognizer'),
  j('@azure/ai-', 'document-intelligence'),
  j('tesseract', '.js'),
  j('node-', 'tesseract-ocr'),
];

export const BANNED_ENV_PATTERN = new RegExp(`(${['OPEN' + 'AI', 'ANTH' + 'ROPIC', 'GEM' + 'INI', 'MIS' + 'TRAL', 'CO' + 'HERE'].join('|')})_`);

export function isBannedPackage(name) {
  return BANNED_PACKAGES.some((b) => (b.endsWith('/') ? name.startsWith(b) : name === b));
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.yaml', '.yml', '.ejs', '.env', '.toml']);
const EXTRA_FILES = new Set(['.env.example', 'Dockerfile']);
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'uploads']);
const SELF = fileURLToPath(import.meta.url);

// import x from 'pkg' / require('pkg') / import('pkg') / export … from 'pkg'
const IMPORT_RE = /(?:from\s+|require\(\s*|import\(\s*|import\s+)['"]([^'"]+)['"]/g;

function pkgName(spec) {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export function scan(root) {
  const failures = [];
  const fail = (file, line, msg) => failures.push(`${relative(root, file) || file}${line ? `:${line}` : ''}  —  ${msg}`);

  // 1. Declared dependencies
  const pkgPath = join(root, 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(pkg[field] ?? {})) {
        if (isBannedPackage(name)) fail(pkgPath, 0, `banned package "${name}" in ${field}`);
      }
    }
  } catch (err) {
    fail(pkgPath, 0, `cannot read package.json: ${err.message}`);
  }

  // 2. Lockfile (catches banned packages pulled in transitively)
  const lockPath = join(root, 'package-lock.json');
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    for (const key of Object.keys(lock.packages ?? {})) {
      const name = key.split('node_modules/').pop();
      if (name && isBannedPackage(name)) fail(lockPath, 0, `banned package "${name}" in lockfile (${key})`);
    }
  } catch {
    /* no lockfile is fine */
  }

  // 3. Source + config files
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (IGNORE_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (full === SELF || entry === 'package-lock.json') continue;
      if (!SOURCE_EXTENSIONS.has(extname(entry)) && !EXTRA_FILES.has(entry) && !entry.startsWith('.env')) continue;

      readFileSync(full, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.matchAll(IMPORT_RE)) {
            const name = pkgName(m[1]);
            if (name && isBannedPackage(name)) fail(full, i + 1, `imports banned package "${name}"`);
          }
          const env = line.match(BANNED_ENV_PATTERN);
          if (env) fail(full, i + 1, `banned AI env var prefix "${env[0]}"`);
        });
    }
  };
  walk(root);
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const root = resolve(process.argv[2] ?? process.cwd());
  console.log('Checking for banned AI packages and env vars…\n');
  const failures = scan(root);
  if (failures.length) {
    for (const f of failures) console.error(`\x1b[31mFAIL\x1b[0m  ${f}`);
    console.error(`\nNo-AI check FAILED (${failures.length} problem${failures.length === 1 ? '' : 's'}).\n`);
    process.exit(1);
  }
  console.log('No-AI check passed: no banned AI packages or env vars found.\n');
}
