import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * Keeps a text filter in the URL without firing a request for every keystroke.
 * Returns the immediate input value plus a setter; the URL (and therefore the
 * query) only follows after `delay` ms of quiet.
 */
export function useDebouncedParam(key: string, delay = 300): [string, (v: string) => void] {
  const [params, setParams] = useSearchParams();
  const [value, setValue] = useState(params.get(key) ?? "");
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    if (value === (paramsRef.current.get(key) ?? "")) return;
    const handle = setTimeout(() => {
      const next = new URLSearchParams(paramsRef.current);
      if (value) next.set(key, value);
      else next.delete(key);
      next.delete("page");
      setParams(next, { replace: true });
    }, delay);
    return () => clearTimeout(handle);
  }, [value, key, delay, setParams]);

  return [value, setValue];
}
