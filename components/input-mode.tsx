'use client';
import { useEffect } from 'react';

// Tracks whether the last interaction was a pointer (mouse/touch/pen) or the keyboard, and records it on <html data-input>.
// globals.css uses it to hide focus rings after a click while keeping them for keyboard (Tab) users.
export default function InputMode() {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.input = 'pointer';
    const pointer = () => { root.dataset.input = 'pointer'; };
    const key = (e: KeyboardEvent) => { if (e.key === 'Tab' || e.key.startsWith('Arrow')) root.dataset.input = 'keyboard'; };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', pointer, true); document.removeEventListener('keydown', key, true); };
  }, []);
  return null;
}
