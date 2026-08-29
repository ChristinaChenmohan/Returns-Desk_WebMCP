import type { Clock, IdGenerator } from "../../worker/domain/primitives";

export const fixedClock: Clock = {
  now: () => new Date("2026-08-29T07:00:00Z"),
};

export function createSequentialIds(): IdGenerator {
  let sequence = 0;

  return {
    next: prefix => {
      sequence += 1;
      return `${prefix}_${sequence}`;
    },
  };
}
