import { useEffect, useState } from "react";

/** The value once it has stopped changing for `ms`: a key being typed or pasted is asked about once, not per keystroke. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}
