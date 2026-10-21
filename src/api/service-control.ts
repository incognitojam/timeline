type SyncConfigChangedNotifier = () => void;

let notifySyncConfigChangedCallback: SyncConfigChangedNotifier = () => {};

export function setSyncConfigChangedNotifier(callback: SyncConfigChangedNotifier): void {
  notifySyncConfigChangedCallback = callback;
}

export function notifySyncConfigChanged(): void {
  notifySyncConfigChangedCallback();
}
