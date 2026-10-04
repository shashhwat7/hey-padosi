// Root redirect wrapper — delegates to the Admin SDK seed script in functions/.
// Run via: npm run seed:users  (from project root)
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');
// LOCAL EMULATOR ONLY. Never run this against a production Firebase project.
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Refusing to seed: emulator not detected.');
  process.exit(1);
}
try {
  execSync('node functions/scripts/seed-admin.js', {
    cwd: projectRoot,
    stdio: 'inherit',
  });
} catch {
  process.exit(1);
}
