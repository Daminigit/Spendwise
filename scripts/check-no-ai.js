#!/usr/bin/env node
// scripts/check-no-ai.js
// CI guard: fails if any banned AI package or env var prefix is found in the codebase.
// Run with: node scripts/check-no-ai.js

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

const BANNED_PACKAGES = [
  'openai',
  '@anthropic-ai/sdk',
  '@google/generative-ai',
  'langchain',
  '"ai"',       // Vercel AI SDK — match exact JSON key to avoid false positives
  'cohere-ai',
  '@mistralai/',
];

const BANNED_ENV_PATTERN = /(OPENAI|ANTHROPIC|GEMINI|MISTRAL|COHERE)_/;

const SOURCE_EXTENSIONS = new Set(['.ts', '.js', '.json', '.env', '.yaml', '.yml']);
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);

let failed = false;

function log(file, line, msg) {
  console.error(`\x1b[31mFAIL\x1b[0m  ${file}:${line}  —  ${msg}`);
  failed = true;
}

function scanFile(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line, i) => {
    const lineNo = i + 1;

    // Check banned packages
    for (const pkg of BANNED_PACKAGES) {
      if (line.includes(pkg)) {
        log(filePath, lineNo, `Banned AI package reference: "${pkg}"`);
      }
    }

    // Check banned env var patterns
    if (BANNED_ENV_PATTERN.test(line)) {
      log(filePath, lineNo, `Banned AI env var pattern found: ${line.trim()}`);
    }
  });
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full);
    } else if (SOURCE_EXTENSIONS.has(extname(entry)) || entry === '.env.example') {
      scanFile(full);
    }
  }
}

console.log('🔍 Checking for banned AI dependencies and env vars...\n');
walk(process.cwd());

if (failed) {
  console.error('\n❌ No-AI check FAILED. Remove the banned references above.\n');
  process.exit(1);
} else {
  console.log('✅ No-AI check passed. No banned AI packages or env vars found.\n');
}

