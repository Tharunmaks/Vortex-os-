// Inline SVG icons (static, trusted markup).
const s = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  terminal: s('<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="m7 9 3 3-3 3M12.5 15h4.5"/>'),
  files: s('<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2.5h6.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>'),
  editor: s('<path d="M14 3H6.5A2.5 2.5 0 0 0 4 5.5v13A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>'),
  browser: s('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>'),
  monitor: s('<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>'),
  hive: s('<path d="M12 2.8 19.5 7v8.6L12 20 4.5 15.6V7z"/><path d="M12 8.2 15.3 10v3.9L12 15.8 8.7 13.9V10z"/>'),
  settings: s('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  calculator: s('<rect x="4.5" y="2.5" width="15" height="19" rx="2.5"/><path d="M8 6.5h8M8 11h.01M12 11h.01M16 11h.01M8 14.5h.01M12 14.5h.01M16 14.5v3.5M8 18h.01M12 18h.01"/>'),
  shield: s('<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z"/><path d="m8.8 12 2.2 2.2 4.2-4.4"/>'),
  apps: s('<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>'),
  min: s('<path d="M6 12h12"/>'),
  max: s('<rect x="5.5" y="5.5" width="13" height="13" rx="2"/>'),
  close: s('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  back: s('<path d="m14.5 6-6 6 6 6"/>'),
  fwd: s('<path d="m9.5 6 6 6-6 6"/>'),
  up: s('<path d="m6 14.5 6-6 6 6"/>'),
  reload: s('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>'),
  home: s('<path d="m3.5 11 8.5-7 8.5 7M6 9.5V20h12V9.5"/>'),
  external: s('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
};

export const gradients = {
  terminal: 'linear-gradient(145deg,#3b3b3b,#111)',
  files: 'linear-gradient(145deg,#ffcf4a,#e08a00)',
  editor: 'linear-gradient(145deg,#60a5fa,#1d4ed8)',
  browser: 'linear-gradient(145deg,#34d399,#047857)',
  monitor: 'linear-gradient(145deg,#f472b6,#be185d)',
  hive: 'linear-gradient(145deg,#ffd23f,#b45309)',
  settings: 'linear-gradient(145deg,#a8a29e,#44403c)',
  calculator: 'linear-gradient(145deg,#fb923c,#c2410c)',
  apps: 'linear-gradient(145deg,#57534e,#1c1917)',
};
