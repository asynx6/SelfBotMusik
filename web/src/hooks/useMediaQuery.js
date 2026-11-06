import { useCallback, useSyncExternalStore } from "react";

/**
 * Reactive `window.matchMedia` wrapper.
 *
 * `useSyncExternalStore` keeps the value correct across renders and re-renders
 * on orientation change / window resize, which a plain `useState` +
 * `useEffect` pair tends to miss on the first paint.
 */
export function useMediaQuery(query) {
  const subscribe = useCallback(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query]
  );

  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** Phones and small tablets — the layout switches to the drawer + compact player. */
export const MOBILE_QUERY = "(max-width: 900px)";

export function useIsMobile() {
  return useMediaQuery(MOBILE_QUERY);
}
