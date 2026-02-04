import test from 'node:test';
import assert from 'node:assert/strict';

import { __test__ } from '../dist/core/cron.js';

test('buildCronBlock contains timezone line and schedule', () => {
  const block = __test__.buildCronBlock();

  assert.equal(block[0], __test__.CRON_BLOCK_BEGIN);
  assert.equal(block[1], __test__.CRON_TZ_LINE);
  assert.equal(
    block[2],
    `${__test__.CRON_SCHEDULE} ${__test__.CRON_COMMAND} ${__test__.CRON_MARKER}`
  );
  assert.equal(block[3], __test__.CRON_BLOCK_END);
});

test('stripExistingBlocks removes managed block and marker lines', () => {
  const input = [
    '# some existing job',
    '* * * * * echo "hi"',
    __test__.CRON_BLOCK_BEGIN,
    __test__.CRON_TZ_LINE,
    `0 2 * * * ${__test__.CRON_COMMAND} ${__test__.CRON_MARKER}`,
    __test__.CRON_BLOCK_END,
    '15 3 * * * echo "bye"',
  ];

  const { cleaned, removed } = __test__.stripExistingBlocks(input);

  assert.equal(removed, 4);
  assert.deepEqual(cleaned, [
    '# some existing job',
    '* * * * * echo "hi"',
    '15 3 * * * echo "bye"',
  ]);
});

test('stripExistingBlocks removes standalone memory-mcp maintenance lines', () => {
  const input = [
    '0 1 * * * echo "ok"',
    `0 2 * * * ${__test__.CRON_COMMAND} ${__test__.CRON_MARKER}`,
    `0 5 * * * npx -y memory-mcp maintenance --action full --dry-run false`,
    '30 6 * * * echo "done"',
  ];

  const { cleaned, removed } = __test__.stripExistingBlocks(input);

  assert.equal(removed, 2);
  assert.deepEqual(cleaned, [
    '0 1 * * * echo "ok"',
    '30 6 * * * echo "done"',
  ]);
});
