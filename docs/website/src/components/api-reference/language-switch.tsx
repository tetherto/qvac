'use client';

import { useEffect, useState } from 'react';

/**
 * Chooses the SDK language field names are shown in. The choice is written to
 * `<html data-sdk-language>`, which the stylesheet reads to show one of the
 * two names every field table carries, and remembered across pages.
 */
const LANGUAGES = [
  { id: 'js', label: 'JavaScript' },
  { id: 'python', label: 'Python' },
] as const;

const STORAGE_KEY = 'qvac-sdk-language';

export function LanguageSwitch() {
  const [language, setLanguage] = useState<string>('js');

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // Storage unavailable: the default stands.
    }
    if (stored === 'js' || stored === 'python') setLanguage(stored);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.sdkLanguage = language;
    try {
      window.localStorage.setItem(STORAGE_KEY, language);
    } catch {
      // Storage unavailable: the choice lasts for this page.
    }
  }, [language]);

  return (
    <div className="qv-language-switch not-prose" role="group" aria-label="Field names for">
      {LANGUAGES.map((entry) => (
        <button
          key={entry.id}
          type="button"
          aria-pressed={language === entry.id}
          onClick={() => setLanguage(entry.id)}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}
