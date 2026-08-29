export interface Clock { now(): Date }
export interface IdGenerator { next(prefix: string): string }

export const systemClock: Clock = { now: () => new Date() };

export const cryptoIds: IdGenerator = {
  next: prefix => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`,
};
