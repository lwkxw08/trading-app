"use client";

import { useCallback, useEffect, useState } from "react";
import { FAVORITES_EVENT, loadFavorites, toggleFavorite } from "@/lib/favorites/store";

export function useFavorites(): { favorites: string[]; toggle: (symbol: string) => void } {
  const [favorites, setFavorites] = useState<string[]>([]);

  useEffect(() => {
    setFavorites(loadFavorites());
    const sync = () => setFavorites(loadFavorites());
    window.addEventListener(FAVORITES_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(FAVORITES_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const toggle = useCallback((symbol: string) => {
    setFavorites(toggleFavorite(symbol));
  }, []);

  return { favorites, toggle };
}
