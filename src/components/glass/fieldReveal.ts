import { createContext } from 'react';

/**
 * Which section a surface has asked to bring into view — Settings search sets
 * it. The `nonce` makes asking for the same section twice a second request,
 * so a section folded again after the first one still opens.
 */
export const FieldRevealContext = createContext<{ anchor: string; nonce: number } | null>(
  null,
);
