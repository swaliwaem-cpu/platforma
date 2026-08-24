export const appLocationChangeEventName = 'platforma-location-changed';

export function notifyAppLocationChanged() {
  window.dispatchEvent(new Event(appLocationChangeEventName));
}
