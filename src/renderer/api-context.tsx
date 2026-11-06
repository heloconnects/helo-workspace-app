import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { HeloBridge, Result } from '../shared/api.js';

export const ApiContext = createContext<HeloBridge | null>(null);

export function useApi(): HeloBridge {
  const api = useContext(ApiContext);
  if (!api) throw new Error('No API');
  return api;
}

/** Load data through a typed operation and reload whenever the app reports a change. */
export function useLoad<T>(load: (api: HeloBridge) => Promise<Result<T>>, deps: unknown[]) {
  const api = useApi();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(async () => {
    const r = await loadRef.current(api);
    if (r.ok) {
      setData(r.value);
      setError(null);
    } else setError(r.error);
  }, [api]);
  useEffect(() => {
    let live = true;
    const run = async () => {
      const r = await loadRef.current(api);
      if (!live) return;
      if (r.ok) {
        setData(r.value);
        setError(null);
      } else setError(r.error);
    };
    void run();
    const off = api.onChanged(() => void run());
    return () => {
      live = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, ...deps]);
  return { data, error, reload };
}
