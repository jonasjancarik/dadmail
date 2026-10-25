import { handleZoomKey } from './zoom';

// Keyboard shortcuts (Thunderbird's, where Dad knows them). The app registers one handler;
// the email frame forwards its own key presses here, so shortcuts work while reading too.

let handler = null;

export function setShortcutHandler(fn) {
  handler = fn;
}

export function handleShortcutKey(event) {
  handleZoomKey(event);
  if (!event.defaultPrevented) handler?.(event);
}
