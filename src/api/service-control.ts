type SyncConfigChangedNotifier = () => void;

let notifySyncConfigChangedCallback: SyncConfigChangedNotifier = () => {};

export function setSyncConfigChangedNotifier(callback: SyncConfigChangedNotifier): void {
  notifySyncConfigChangedCallback = callback;
}

export function notifySyncConfigChanged(): void {
  notifySyncConfigChangedCallback();
}

let databaseInitializedByService = false;

/**
 * Called by the service once it has run initDb() itself, before starting the
 * scheduler worker. The API then skips its own initDb(), which would otherwise
 * run schema work while syncs are already writing.
 */
export function markDatabaseInitializedByService(): void {
  databaseInitializedByService = true;
}

export function isDatabaseInitializedByService(): boolean {
  return databaseInitializedByService;
}
