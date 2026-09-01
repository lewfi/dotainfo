import { createCatalog } from '../src/data/catalog.mjs';
import { auditSealedData, sealedAuditDifferences } from '../src/data/audit.mjs';
import { openDuckDB } from '../src/data/duckdb.mjs';
import { DataReader } from '../src/data/queries.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
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
    const partB = await reader.windows({ clock });
    console.log(`PART_B_CLOCK=${clock}`);
    for (const result of partB) {
      console.log(`PART_B_${result.days}_DAYS=${JSON.stringify(result)}`);
    }
  }
} finally {
  database.close();
}
