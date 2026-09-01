import { createSqliteBackup } from './backup.js';

function parseRetention(value: string | undefined) {
  if (value === undefined || value === '') return 14;
  if (!/^\d+$/.test(value)) throw new TypeError('BACKUP_RETENTION must be a positive integer');
  const retention = Number(value);
  if (!Number.isSafeInteger(retention) || retention < 1) {
    throw new TypeError('BACKUP_RETENTION must be a positive safe integer');
  }
  return retention;
}

async function main() {
  if (process.argv.length !== 2) throw new TypeError('Backup CLI accepts configuration through environment variables only');
  const sourcePath = process.env.DATABASE_PATH;
  const backupDirectory = process.env.BACKUP_DIRECTORY;
  if (!sourcePath) throw new TypeError('DATABASE_PATH is required');
  if (!backupDirectory) throw new TypeError('BACKUP_DIRECTORY is required');

  const metadata = await createSqliteBackup({
    sourcePath,
    backupDirectory,
    retention: parseRetention(process.env.BACKUP_RETENTION),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...metadata })}\n`);
}

try {
  await main();
} catch {
  process.stderr.write(`${JSON.stringify({ ok: false, error: 'backup_failed' })}\n`);
  process.exitCode = 1;
}
