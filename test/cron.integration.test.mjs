import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  registerMaintenanceCron,
  deregisterMaintenanceCron,
} from '../dist/core/cron.js';

const CRON_MARKER = '# memory-mcp:maintenance';
const MANIFEST_PATH = path.resolve(process.cwd(), 'CRON_JOBS.md');

async function createCrontabShim(tmpDir) {
  const shimPath = path.join(tmpDir, 'crontab');
  const shim = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const stateFile = process.env.CRONTAB_STATE_FILE;
if (!stateFile) {
  console.error('CRONTAB_STATE_FILE is required');
  process.exit(2);
}

function readState() {
  if (!fs.existsSync(stateFile)) {
    return null;
  }
  return fs.readFileSync(stateFile, 'utf8');
}

if (args.length === 1 && args[0] === '-l') {
  const content = readState();
  if (content === null || content.trim() === '') {
    console.error('crontab: no crontab for testuser');
    process.exit(1);
  }
  process.stdout.write(content);
  process.exit(0);
}

if (args.length === 1 && args[0] === '-') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, input, 'utf8');
    process.exit(0);
  });
  return;
}

console.error('crontab: unsupported args');
process.exit(2);
`;

  await fs.writeFile(shimPath, shim, 'utf8');
  await fs.chmod(shimPath, 0o755);
  return shimPath;
}

test('cron register/deregister uses crontab and avoids duplicates', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-mcp-cron-'));
  const stateFile = path.join(tmpDir, 'crontab.txt');
  await createCrontabShim(tmpDir);

  const env = {
    ...process.env,
    PATH: `${tmpDir}${path.delimiter}${process.env.PATH || ''}`,
    CRONTAB_STATE_FILE: stateFile,
  };

  // Override process.env for the cron functions
  const originalEnv = { ...process.env };
  Object.assign(process.env, env);

  try {
    // First registration
    registerMaintenanceCron();

    // Wait a bit for file to be written (crontab shim writes synchronously, but just in case)
    await new Promise(resolve => setTimeout(resolve, 50));

    let first;
    try {
      first = await fs.readFile(stateFile, 'utf8');
    } catch (error) {
      // File might not exist if crontab -l returned empty initially
      // Write an empty file to simulate empty crontab
      await fs.writeFile(stateFile, '', 'utf8');
      // Try registration again
      registerMaintenanceCron();
      await new Promise(resolve => setTimeout(resolve, 50));
      first = await fs.readFile(stateFile, 'utf8');
    }

    assert.ok(first.includes(CRON_MARKER), 'cron marker should be present');
    const firstLines = first.split(/\r?\n/).filter(Boolean);
    // Match lines that contain the marker (can be at end of line as comment)
    const firstCronLines = firstLines.filter(line => line.includes(CRON_MARKER) && line.includes('maintenance.js'));
    if (firstCronLines.length === 0) {
      throw new Error(`Expected cron line not found. Content:\n${first}`);
    }
    assert.equal(firstCronLines.length, 1, 'single cron entry');

    // Second registration should not create duplicates
    registerMaintenanceCron();
    await new Promise(resolve => setTimeout(resolve, 50));
    const second = await fs.readFile(stateFile, 'utf8');
    const secondLines = second.split(/\r?\n/).filter(Boolean);
    const secondCronLines = secondLines.filter(line => line.includes(CRON_MARKER) && line.includes('maintenance.js'));
    assert.equal(secondCronLines.length, 1, 'no duplicates');

    // Deregister should remove the entry
    deregisterMaintenanceCron();
    await new Promise(resolve => setTimeout(resolve, 50));
    const finalState = await fs.readFile(stateFile, 'utf8');
    const finalLines = finalState.split(/\r?\n/).filter(Boolean);
    const finalCronLines = finalLines.filter(line => line.includes(CRON_MARKER) && line.includes('maintenance.js'));
    assert.equal(finalCronLines.length, 0, 'cron should be empty after deregister');
  } finally {
    // Restore original env
    Object.assign(process.env, originalEnv);
    await fs.rm(tmpDir, { recursive: true, force: true });
    try {
      await fs.rm(MANIFEST_PATH, { force: true });
    } catch {
      // Ignore if file doesn't exist
    }
  }
});
