export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_ENV: "development" | "test" | "production";
  CHANNEL_SIGNING_KEY: string;
}
