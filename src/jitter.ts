import { createHash } from "node:crypto";

/**
 * Source of schedule spread. `unit` maps a key to a value in [0, 1). The same
 * key must always map to the same value, so a resumed watch recomputes the due
 * time it had before suspension and nothing about jitter needs persisting.
 */
export interface UntilJitter {
  readonly unit: (key: string) => number;
}

const UINT32_RANGE = 2 ** 32;

/** Hash the key; watch ids are random, so different watches spread apart. */
export const systemJitter: UntilJitter = {
  unit: (key) =>
    createHash("sha256").update(key).digest().readUInt32BE(0) / UINT32_RANGE,
};
