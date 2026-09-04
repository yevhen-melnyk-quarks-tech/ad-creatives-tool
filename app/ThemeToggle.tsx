"use client";

import { useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "ad-creatives-theme";

const prefersDark = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;

/**
 * Applies a choice by resolving it to an explicit attribute.
 *
 * "system" is resolved here rather than handed to a CSS media query, so the dark
 * palette lives in exactly one place. The cost is that following the OS has to be
 * done in JS, which the effect below handles.
 */
function apply(choice: ThemeChoice) {
  const dark = choice === "dark" || (choice === "system" && prefersDark());
  const root = document.documentElement;
  if (dark) root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
}

export default function ThemeToggle() {
  // Starts as null so the first render matches the server's markup exactly; the real
  // choice is read from storage after mount. The inline script in the layout has
  // already painted the correct theme by then, so there is nothing to see.
  const [choice, setChoice] = useState<ThemeChoice | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as ThemeChoice | null;
    const initial: ThemeChoice = stored === "light" || stored === "dark" ? stored : "system";
    setChoice(initial);

    // On "system", track the OS live so flipping appearance with this tab open is
    // picked up — the behaviour a CSS media query would have given for free.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const current = localStorage.getItem(STORAGE_KEY);
      if (current !== "light" && current !== "dark") apply("system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  function pick(next: ThemeChoice) {
    setChoice(next);
    apply(next);
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private browsing can refuse storage; the choice still applies for this page.
    }
  }

  const options: [ThemeChoice, string][] = [
    ["light", "Light"],
    ["dark", "Dark"],
    ["system", "System"],
  ];

  return (
    <div className="flex gap-1 rounded-md bg-surface-sunken p-0.5 text-xs" aria-label="Colour theme">
      {options.map(([value, label]) => (
        <button
          key={value}
          onClick={() => pick(value)}
          aria-pressed={choice === value}
          // Nothing is marked active until the stored choice is known, so the button
          // highlight cannot briefly contradict the theme already on screen.
          className={`rounded px-2 py-0.5 font-medium transition-all active:scale-95 ${
            choice === value ? "bg-surface text-ink shadow-sm" : "text-ink-subtle"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
