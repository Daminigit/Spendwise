/**
 * src/config.ts
 *
 * Public base URL of this deployment (no trailing slash), used for connector
 * URLs, claim links and invite links. APP_URL wins; on Render the platform's
 * RENDER_EXTERNAL_URL is used automatically; otherwise localhost.
 */
export function appUrl(): string {
  const url = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT ?? 3000}`;
  return url.replace(/\/+$/, '');
}
