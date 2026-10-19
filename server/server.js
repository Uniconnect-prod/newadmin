import { config } from './src/config/index.js';
import { initStore } from './src/store/index.js';
import { seedReferenceData } from './src/store/seed.js';
import { createApp } from './src/app.js';
import { isVaultConfigured } from './src/integrations/secretVault.js';

import { userRepository } from './src/repositories/userRepository.js';

process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled rejection]', reason);
});

async function start() {
  await initStore();
  await seedReferenceData();

  // Purge any non-super-admin accounts that have reached or passed their end date
  try {
    const expired = await userRepository.cleanupExpiredUsers();
    if (expired?.length) {
      console.log(`[Users] Cleaned up ${expired.length} expired user account(s) on startup.`);
    }
  } catch (err) {
    console.warn('[Users] Failed running initial expired user cleanup:', err.message);
  }

  // Periodic cleanup every 5 minutes
  setInterval(async () => {
    try {
      const expired = await userRepository.cleanupExpiredUsers();
      if (expired?.length) {
        console.log(`[Users] Periodically removed ${expired.length} expired user account(s).`);
      }
    } catch (err) {
      console.warn('[Users] Periodic expired user cleanup failed:', err.message);
    }
  }, 5 * 60 * 1000).unref();

  if (!isVaultConfigured()) {
    console.warn('[Config] INTEGRATION_SECRET_KEY is not set (or not 32 bytes). Platform API credentials cannot be saved or used until it is configured.');
  }
  if (config.outbound.allowPrivateHosts.length) {
    console.warn(`[Config] Private-network outbound exceptions enabled for: ${config.outbound.allowPrivateHosts.join(', ')}`);
  }

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`[Server] Reporting API listening on http://localhost:${config.port} (store: ${config.reportingStore})`);
  });
}

start().catch((err) => {
  console.error('[Server] Fatal start-up error:', err);
  process.exit(1);
});
