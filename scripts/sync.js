'use strict';

// One-shot pipeline run from the CLI: `npm run sync`. Useful for cron-less
// environments or manual snapshot generation.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const { runPipeline } = require('../lib/pipeline');

runPipeline()
  .then((data) => {
    console.log(`Done. ${data.scoreboard.active} active clients synced at ${data.syncedAt}.`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('Sync failed:', err);
    process.exit(1);
  });
