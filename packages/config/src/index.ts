import { Config } from "effect"

export const DatabaseUrl = Config.string("DATABASE_URL")
export const SessionSecret = Config.string("SESSION_SECRET")
export const WorkerPath = Config.string("GHOSTPING_WORKER_PATH")
export const AppBaseUrl = Config.string("APP_BASE_URL").pipe(Config.withDefault("http://localhost:3000"))
export const Port = Config.integer("PORT").pipe(Config.withDefault(3001))

export const AppConfig = Config.all({ DatabaseUrl, SessionSecret, WorkerPath, AppBaseUrl, Port })
export type AppConfig = typeof AppConfig extends { [k: string]: unknown } ? { databaseUrl: string; sessionSecret: string; workerPath: string; appBaseUrl: string; port: number } : never
