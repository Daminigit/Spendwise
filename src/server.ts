/**
 * src/server.ts
 *
 * Entry point: builds the app and starts listening.
 */

import 'dotenv/config';
import { createApp } from './web/app.js';
import { appUrl } from './config.js';

const port = Number(process.env.PORT ?? 3000);
const app = createApp();

app.listen(port, () => {
  console.log(`Spendwise listening on port ${port} (public URL: ${appUrl()})`);
});
