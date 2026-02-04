#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import {
  ensureMemoryDir,
  getConfig,
  getDatabasePath,
  getEmbeddingApiKey,
} from './core/config.js';
import { createDatabase, initSchema, EMBEDDING_DIMENSIONS } from './core/database.js';
import { runMaintenance } from './core/maintenance.js';
import {
  registerMaintenanceCron,
  deregisterMaintenanceCron,
} from './core/cron.js';
import { cleanupMemoryFile } from './core/promotion.js';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { execFileSync } from 'child_process';

const CRON_MARKER = '# memory-mcp:maintenance';

// ============================================================================
// Helpers
// ============================================================================

function parseFlag(args: string[], name: string): string | undefined {
  const flag = `--${name}`;
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function parseBoolFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (value === 'true' || value === '1') {
    return true;
  }
  if (value === 'false' || value === '0') {
    return false;
  }
  return fallback;
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=["']?(.*)["']?$/);
    if (match) {
      env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

function getOpenaiApiKey(): string {
  // 1. Check process.env first
  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }

  // 2. Try local .env file
  const localEnvPath = path.join(process.cwd(), '.env');
  const localEnv = parseEnvFile(localEnvPath);
  if (localEnv.OPENAI_API_KEY) {
    return localEnv.OPENAI_API_KEY;
  }

  // 3. Fail
  console.error('Error: OPENAI_API_KEY not found.');
  console.error('Set it in your environment or in a local .env file.');
  process.exit(1);
}

// ============================================================================
// Run Command
// ============================================================================

async function runCommand(args: string[]): Promise<void> {
  const openaiApiKey = getOpenaiApiKey();

  try {
    const config = getConfig();
    ensureMemoryDir(config.memoryDir);

    const actionArg = parseFlag(args, 'action');
    const dryRunArg = parseFlag(args, 'dry-run');
    const action = (actionArg as 'check' | 'full') || 'full';
    const dryRun = parseBoolFlag(dryRunArg, true);

    const db = createDatabase(getDatabasePath(config.memoryDir));
    const embeddingDim = EMBEDDING_DIMENSIONS[config.embeddingProvider] || 384;
    initSchema(db, embeddingDim);

    const summary = await runMaintenance(
      db,
      config.memoryDir,
      config.maintenance,
      action,
      {
        embeddingConfig: {
          provider: config.embeddingProvider,
          apiKey: getEmbeddingApiKey(config),
          model: config.embeddingModel,
        },
        llmProvider: 'openai',
        openaiApiKey,
        llmModel: config.llmModel,
      },
      dryRun
    );

    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error('Maintenance failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// ============================================================================
// Schedule Command
// ============================================================================

interface MaintenanceSchedule {
  found: boolean;
  schedule?: string;
  command?: string;
}

function getCurrentSchedule(): MaintenanceSchedule {
  try {
    const crontab = execFileSync('crontab', ['-l'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    for (const line of crontab.split('\n')) {
      if (line.includes(CRON_MARKER) || /\bmemory-mcp\b.*\bmaintenance\b/.test(line)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 6) {
          const schedule = parts.slice(0, 5).join(' ');
          const command = parts.slice(5).join(' ').replace(CRON_MARKER, '').trim();
          return { found: true, schedule, command };
        }
      }
    }
  } catch (error) {
    const err = error as { stderr?: string; stdout?: string; message?: string };
    const combined = `${err.stderr || ''}${err.stdout || ''}${err.message || ''}`;
    if (/no crontab for/i.test(combined)) {
      return { found: false };
    }
    throw error;
  }

  return { found: false };
}

function formatSchedule(schedule: string): string {
  const [min, hour, dom, mon, dow] = schedule.split(' ');
  if (min === '0' && dom === '*' && mon === '*' && dow === '*') {
    return `Daily at ${hour.padStart(2, '0')}:00 UTC`;
  }
  return `Cron: ${schedule}`;
}

async function scheduleCommand(): Promise<void> {
  const rl = readline.createInterface({ input, output });

  const question = async (prompt: string): Promise<string> => {
    const answer = await rl.question(prompt);
    return answer.trim().toLowerCase();
  };

  console.log('\n🔧 Memory MCP Maintenance Schedule\n');

  const current = getCurrentSchedule();

  if (current.found) {
    console.log('📅 Current schedule:');
    console.log(`   ${formatSchedule(current.schedule!)}`);
    console.log(`   Command: ${current.command}\n`);
  } else {
    console.log('📅 No maintenance schedule found.\n');
  }

  const action = await question(
    'What would you like to do?\n' +
    '  [c] Create schedule (daily at 09:00 UTC)' + (current.found ? ' - replaces existing' : '') + '\n' +
    '  [r] Remove schedule\n' +
    '  [q] Quit\n\n' +
    'Choice (c/r/q): '
  );

  if (action === 'c') {
    if (!process.env.OPENAI_API_KEY) {
      console.log('\n⚠️  Warning: OPENAI_API_KEY not found in environment.');
      console.log('   The cron job will fail unless the key is available at runtime.');
      console.log('   Set it in your shell profile (~/.zshrc, ~/.bashrc).\n');

      const proceed = await question('Continue anyway? (y/n): ');
      if (proceed !== 'y' && proceed !== 'yes') {
        console.log('\n❌ Cancelled.');
        rl.close();
        return;
      }
    }

    const result = registerMaintenanceCron();
    console.log('\n✅ Schedule created.');
    console.log(`   Schedule: Daily at 09:00 UTC`);
    console.log(`   Command: ${result.command}`);
    if (result.removedCount > 0) {
      console.log(`   Replaced ${result.removedCount} existing entries.`);
    }
  } else if (action === 'r') {
    const result = deregisterMaintenanceCron();
    if (result.removedCount > 0) {
      console.log(`\n✅ Removed ${result.removedCount} cron entries.`);
    } else {
      console.log('\n✓ No schedule to remove.');
    }
  } else {
    console.log('\n✓ No changes.');
  }

  console.log('');
  rl.close();
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'run' || command === undefined || command.startsWith('--')) {
    // Default to run
    const runArgs = command === 'run' ? args.slice(1) : args;
    await runCommand(runArgs);
    return;
  }

  if (command === 'schedule') {
    await scheduleCommand();
    return;
  }

  console.error('Usage: local-memory-mcp-maintenance [run|schedule] [options]');
  console.error('');
  console.error('Commands:');
  console.error('  run       Run maintenance (default)');
  console.error('            --action <check|full> (default: full)');
  console.error('            --dry-run <true|false> (default: true)');
  console.error('');
  console.error('Actions:');
  console.error('  check     Show maintenance status only');
  console.error('  full      Run all maintenance tasks: retention → compact → promote → conflicts → cleanup');
  console.error('  schedule  Manage cron schedule');
  process.exit(1);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
