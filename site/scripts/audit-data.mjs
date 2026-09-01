import { createCatalog } from '../src/data/catalog.mjs';
import { auditSealedData, sealedAuditDifferences } from '../src/data/audit.mjs';
import { directWindowAudit } from '../src/data/direct-window-audit.mjs';
import { openDuckDB } from '../src/data/duckdb.mjs';
import { DataReader } from '../src/data/queries.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function windowDifferences(queryResults, directResults) {
  const differences = [];
  for (const queryResult of queryResults) {
    const directResult = directResults.find((result) => result.days === queryResult.days);
    if (!directResult) {
      differences.push(`${queryResult.days}-day direct result is missing`);
      continue;
    }
    if (queryResult.count !== directResult.count) {
      differences.push(
        `${queryResult.days}-day count: query ${queryResult.count}, direct ${directResult.count}`,
      );
    }
    const tiers = new Set([
      ...Object.keys(queryResult.tiers),
      ...Object.keys(directResult.tiers),
    ]);
    for (const tier of tiers) {
      const queryCount = queryResult.tiers[tier] ?? 0;
      const directCount = directResult.tiers[tier] ?? 0;
      if (queryCount !== directCount) {
        differences.push(
          `${queryResult.days}-day ${tier}: query ${queryCount}, direct ${directCount}`,
        );
      }
    }
  }
  return differences;
}

const clock = argument('--clock');
if (!clock) {
  console.error('usage: npm run audit:data -- --clock YYYY-MM-DDTHH:mm:ssZ');
  process.exit(2);
}

const catalog = await createCatalog();
const database = await openDuckDB();

try {
  const partA = await auditSealedData(catalog, database.connection);
  console.log(`PART_A=${JSON.stringify(partA)}`);
  const differences = sealedAuditDifferences(partA);
  if (differences.length > 0) {
    console.error(`PART_A_MISMATCH=${JSON.stringify(differences)}`);
    process.exitCode = 1;
  } else {
    console.log('PART_A_STATUS=PASS');
    const reader = new DataReader(catalog, database);
    const queryWindows = await reader.windows({ clock });
    const directWindows = await directWindowAudit({ clock });
    console.log(`PART_B_CLOCK=${clock}`);
    for (const queryResult of queryWindows) {
      const directResult = directWindows.find((result) => result.days === queryResult.days);
      console.log(`PART_B_${queryResult.days}_DAYS_QUERY=${JSON.stringify(queryResult)}`);
      console.log(`PART_B_${queryResult.days}_DAYS_DIRECT=${JSON.stringify(directResult)}`);
    }
    const windowMismatch = windowDifferences(queryWindows, directWindows);
    if (windowMismatch.length > 0) {
      console.error(`PART_B_MISMATCH=${JSON.stringify(windowMismatch)}`);
      process.exitCode = 1;
    } else {
      console.log('PART_B_CROSS_CHECK=PASS');
    }
  }
} finally {
  database.close();
}
