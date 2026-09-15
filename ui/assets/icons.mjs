// Inline SVG icon set. No icon font, no network fetch — every icon is a
// string so it can be interpolated into templates (all static markup, never
// remote data). Stroke icons share viewBox 0 0 24 24, stroke currentColor.

const wrap = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

export const icons = {
  search: wrap('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/>'),
  download: wrap('<path d="M12 4v11m0 0 4-4m-4 4-4-4"/><path d="M4 19h16"/>'),
  seed: wrap('<path d="M12 15V5m0 0 4 4m-4-4-4 4"/><path d="M4 17c2.7-1.4 13.3-1.4 16 0"/>'),
  stop: wrap('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  copy: wrap('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>'),
  check: wrap('<path d="m4.5 12.5 5 5 10-11"/>'),
  close: wrap('<path d="M6 6l12 12M18 6 6 18"/>'),
  key: wrap('<circle cx="8" cy="14" r="4.5"/><path d="m11.5 10.5 8-8m-3 3 3 3"/>'),
  peers: wrap('<circle cx="6" cy="6" r="2.6"/><circle cx="18" cy="6" r="2.6"/><circle cx="12" cy="18" r="2.6"/><path d="M8.3 7.5 10.6 15.7M15.7 7.5l-2.3 8.2M8.6 6h6.8"/>'),
  flag: wrap('<path d="M6 21V4"/><path d="M6 4h11l-2.5 4L17 12H6"/>'),
  voteUp: wrap('<path d="M7 11v9H4v-9h3Z"/><path d="M7 11l4.5-7c1.5 0 2.4 1.2 2.1 2.7L13 10h6a2 2 0 0 1 2 2.4l-1.3 6A2 2 0 0 1 17.7 20H7"/>'),
  voteDown: wrap('<path d="M17 13V4h3v9h-3Z"/><path d="M17 13l-4.5 7c-1.5 0-2.4-1.2-2.1-2.7L11 14H5a2 2 0 0 1-2-2.4l1.3-6A2 2 0 0 1 6.3 4H17"/>'),
  folder: wrap('<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>'),
  cloud: wrap('<path d="M7 18a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 18.3 11 3.8 3.8 0 0 1 17.5 18H7Z"/>'),
  warn: wrap('<path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.2" r="0.4" fill="currentColor"/>'),
  info: wrap('<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.4" fill="currentColor"/>'),
  filter: wrap('<path d="M4 6h16M7 12h10M10 18h4"/>'),
  external: wrap('<path d="M10 5H5v14h14v-5"/><path d="M14 4h6v6"/><path d="M20 4 11 13"/>'),
  file: wrap('<path d="M6 3h8l4 4v14H6V3Z"/><path d="M14 3v4h4"/>'),
  cube: wrap('<path d="M12 2.5 21 7.5v9l-9 5-9-5v-9l9-5Z"/><path d="M3.2 7.6 12 12.5l8.8-4.9M12 12.5V21"/>'),
  arrowRight: wrap('<path d="M4 12h15m0 0-5-5m5 5-5 5"/>'),
  spark: wrap('<path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2Z"/>'),
  clock: wrap('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>'),
  dot: '<svg viewBox="0 0 8 8" aria-hidden="true"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>'
}

export function icon (name) {
  return icons[name] || icons.dot
}
