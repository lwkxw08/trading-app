"use client";

import { useMemo, useState } from "react";
import { useFavorites } from "./useFavorites";

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** Comma-separated multi-symbol mode: selecting a favourite appends it. */
  multi?: boolean;
  /** Show the star button to add/remove the typed symbol from favourites (single mode only). */
  withStar?: boolean;
}

function splitSymbols(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

export default function SymbolInput({ value, onChange, placeholder, className, multi = false, withStar = true }: Props) {
  const { favorites, toggle } = useFavorites();
  const [open, setOpen] = useState(false);

  const current = value.trim().toUpperCase();
  const selected = useMemo(() => (multi ? splitSymbols(value) : []), [multi, value]);
  const lastSegment = (value.split(",").pop() ?? "").trim().toUpperCase();
  const lastIsComplete = lastSegment !== "" && favorites.includes(lastSegment);
  const query = multi ? (lastIsComplete ? "" : lastSegment) : current;

  const options = useMemo(() => {
    const pool = multi ? favorites.filter((f) => !selected.includes(f)) : favorites;
    return query ? pool.filter((f) => f.includes(query)) : pool;
  }, [favorites, multi, selected, query]);

  const pick = (symbol: string) => {
    if (multi) {
      // A partial final segment is replaced by the pick; complete symbols are kept.
      const parts = splitSymbols(value);
      const base = lastIsComplete || lastSegment === "" ? parts : parts.slice(0, -1);
      const next = [...base.filter((s) => s !== symbol), symbol];
      onChange(next.join(", "));
    } else {
      onChange(symbol);
    }
    setOpen(false);
  };

  const useAllFavorites = () => {
    onChange(favorites.join(", "));
    setOpen(false);
  };

  const isFav = !multi && current.length > 0 && favorites.includes(current);

  return (
    <div className="relative inline-flex items-center">
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        className={`${className ?? ""} ${!multi && withStar ? "pr-7" : ""}`}
      />
      {!multi && withStar && (
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => current && toggle(current)}
          title={isFav ? "Remove from favourites" : "Save to favourites"}
          className={`absolute right-1.5 text-sm leading-none ${isFav ? "text-amber-400" : "text-muted hover:text-amber-400"}`}
        >
          {isFav ? "★" : "☆"}
        </button>
      )}
      {open && (options.length > 0 || (multi && favorites.length > 0)) && (
        <ul className="absolute left-0 top-full z-20 mt-1 max-h-56 w-full min-w-40 overflow-auto rounded-md border border-edge bg-surface py-1 shadow-lg">
          {multi && favorites.length > 0 && (
            <li>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={useAllFavorites}
                className="block w-full px-2 py-1 text-left text-xs font-semibold text-accent hover:bg-edge"
              >
                Use all favourites ({favorites.length})
              </button>
            </li>
          )}
          {options.map((f) => (
            <li key={f}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(f)}
                className="block w-full px-2 py-1 text-left font-mono text-xs hover:bg-edge"
              >
                <span className="mr-1 text-amber-400">★</span>
                {f}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
