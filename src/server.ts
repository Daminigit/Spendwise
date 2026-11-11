/**
 * src/server.ts
 *
 * Entry point: builds the app and starts listening.
 */

import 'dotenv/config';
import { createApp } from './web/app.js';

const port = Number(process.env.PORT ?? 3000);
const app = createApp();

app.listen(port, () => {
  console.log(`Spendwise listening on ${process.env.APP_URL ?? `http://localhost:${port}`}`);
});
