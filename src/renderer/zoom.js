import { api } from './api';

// Text size: zooms the whole window, email contents included (saved by the backend)

export const ZOOM_LEVELS = [
  { value: 1, label: 'Normální' },
  { value: 1.15, label: 'Větší' },
  { value: 1.3, label: 'Velké' },
  { value: 1.5, label: 'Velmi velké' },
  { value: 1.75, label: 'Největší' },
];

let current = 1;

export function initZoom(saved) {
  current = parseFloat(saved) || 1;
}

export const getZoom = () => current;

export async function setZoom(zoom) {
  current = await api.setZoom(zoom);
  return current;
}

// Ctrl (Cmd on Mac) with + or - steps through the sizes, with 0 back to normal.
// Also attached inside the email frame, which gets its own key presses.
export function handleZoomKey(event) {
  if (!(event.ctrlKey || event.metaKey)) return;
  const values = ZOOM_LEVELS.map((level) => level.value);
  const index = values.findIndex((value) => value >= current - 0.01);
  let next;
  if (event.key === '+' || event.key === '=') {
    next = values[Math.min(index + 1, values.length - 1)];
  } else if (event.key === '-') {
    next = values[Math.max(index - 1, 0)];
  } else if (event.key === '0') {
    next = 1;
  } else {
    return;
  }
  event.preventDefault();
  setZoom(next);
}
