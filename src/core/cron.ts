import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CRON_BLOCK_BEGIN = '# memory-mcp:maintenance:begin';
const CRON_BLOCK_END = '# memory-mcp:maintenance:end';
const CRON_MARKER = '# memory-mcp:maintenance';
const CRON_TZ_LINE = 'CRON_TZ=UTC';

const CRON_SCHEDULE = '0 9 * * *';

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);

// Uses ANTHROPIC_API_KEY and LOCAL_MEMORY_MCP from environment
const CRON_COMMAND = 'node "$LOCAL_MEMORY_MCP/dist/maintenance.js" run --action full --dry-run false';

const CRON_MANIFEST_PATH = path.join(PACKAGE_ROOT, 'CRON_JOBS.md');

export interface CronUpdateResult {
  added: boolean;
  removedCount: number;
  cronLine: string;
  schedule: string;
  command: string;
}

function readCrontab(): string[] {
  try {
    const output = execFileSync('crontab', ['-l'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.split(/\r?\n/).filter(line => line.length > 0);
  } catch (error) {
    const err = error as { stderr?: string; stdout?: string; message?: string };
    const combined = `${err.stderr || ''}${err.stdout || ''}${err.message || ''}`;
    if (/no crontab for/i.test(combined)) {
      return [];
    }
    throw error;
  }
}

function writeCrontab(lines: string[]): void {
  const content = lines.join('\n').trimEnd();
  execFileSync('crontab', ['-'], {
    input: content.length > 0 ? `${content}\n` : '\n',
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function stripExistingBlocks(lines: string[]): { cleaned: string[]; removed: number } {
  const cleaned: string[] = [];
  let removed = 0;
  let inBlock = false;

  for (const line of lines) {
    if (line.trim() === CRON_BLOCK_BEGIN) {
      inBlock = true;
      removed += 1;
      continue;
    }

    if (line.trim() === CRON_BLOCK_END) {
      inBlock = false;
      removed += 1;
      continue;
    }

    if (inBlock) {
      removed += 1;
      continue;
    }

    if (line.includes(CRON_MARKER)) {
      removed += 1;
      continue;
    }

    if (/\bmemory-mcp\b.*\bmaintenance\b/.test(line)) {
      removed += 1;
      continue;
    }

    cleaned.push(line);
  }

  return { cleaned, removed };
}

function buildCronBlock(): string[] {
  const cronLine = `${CRON_SCHEDULE} ${CRON_COMMAND} ${CRON_MARKER}`;
  return [
    CRON_BLOCK_BEGIN,
    CRON_TZ_LINE,
    cronLine,
    CRON_BLOCK_END,
  ];
}

function writeCronManifest(result: CronUpdateResult): void {
  const registeredAt = new Date().toISOString();
  const cronLine = `${result.schedule} ${result.command} ${CRON_MARKER}`;
  const content = [
    '# Memory MCP Cron Jobs',
    '',
    `Registered at (UTC): ${registeredAt}`,
    `Schedule: daily at 09:00 UTC`,
    '',
    'Cron entry:',
    '```',
    CRON_BLOCK_BEGIN,
    CRON_TZ_LINE,
    cronLine,
    CRON_BLOCK_END,
    '```',
    '',
    'Deregister:',
    '```',
    'npx memory-mcp cron deregister',
    '```',
    '',
    'Notes:',
    '- Registration replaces any redundant memory-mcp maintenance cron entries.',
  ].join('\n');

  writeFileSync(CRON_MANIFEST_PATH, content, 'utf8');
}

export function registerMaintenanceCron(): CronUpdateResult {
  const existing = readCrontab();
  const { cleaned, removed } = stripExistingBlocks(existing);
  const block = buildCronBlock();
  const cronLine = `${CRON_SCHEDULE} ${CRON_COMMAND} ${CRON_MARKER}`;
  const updated = cleaned.concat(block);

  writeCrontab(updated);

  const result: CronUpdateResult = {
    added: true,
    removedCount: removed,
    cronLine,
    schedule: CRON_SCHEDULE,
    command: CRON_COMMAND,
  };

  writeCronManifest(result);
  return result;
}

export function deregisterMaintenanceCron(): CronUpdateResult {
  const existing = readCrontab();
  const { cleaned, removed } = stripExistingBlocks(existing);
  writeCrontab(cleaned);

  return {
    added: false,
    removedCount: removed,
    cronLine: `${CRON_SCHEDULE} ${CRON_COMMAND} ${CRON_MARKER}`,
    schedule: CRON_SCHEDULE,
    command: CRON_COMMAND,
  };
}

export const __test__ = {
  stripExistingBlocks,
  buildCronBlock,
  CRON_BLOCK_BEGIN,
  CRON_BLOCK_END,
  CRON_MARKER,
  CRON_TZ_LINE,
  CRON_SCHEDULE,
  CRON_COMMAND,
};
