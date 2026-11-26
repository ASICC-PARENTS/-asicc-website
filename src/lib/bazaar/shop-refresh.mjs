// The timer only checks local state; Firestore is queried when a refresh is due.
export const SHOP_REFRESH_CHECK_MS = 15_000;
export function shouldRefreshShop({hidden,submitted,submitting,pending,closed,lastAttempt,now,resumed=false}){
  if(hidden||submitted||submitting||pending||closed)return false;
  const interval=resumed?30_000:60_000;
  return now-lastAttempt>=interval;
}
