/** Set to the https://...workers.dev origin after deploying the ASICC private photo Worker.
 * Leave blank to keep photo uploading disabled until the private API is ready.
 * Never put Backblaze credentials in this file.
 */
export const BOARD_PHOTO_API = import.meta.env.PUBLIC_ASICC_INTEGRATION_TEST === 'true'
  ? (import.meta.env.PUBLIC_ASICC_BAZAAR_WORKER_URL || '') : 'https://asicc-media-api.laniya82.workers.dev';

export const MEMBER_NOTIFICATION_API = import.meta.env.PUBLIC_ASICC_INTEGRATION_TEST === 'true'
  ? '' : BOARD_PHOTO_API;
