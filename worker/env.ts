import type { Language, Role } from "@shared/types";

export interface SendEmailBinding {
  send(message: {
    to: string | string[];
    from: string | { email: string; name?: string };
    subject: string;
    html?: string;
    text?: string;
    replyTo?: string;
    attachments?: { content: string | ArrayBuffer | ArrayBufferView; filename: string; type: string; disposition?: "attachment" | "inline" }[];
  }): Promise<{ messageId?: string }>;
}

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  KV: KVNamespace;
  VEHICLE_LOCK: DurableObjectNamespace;
  EMAIL?: SendEmailBinding;
  ASSETS: Fetcher;
  APP_NAME: string;
  PUBLIC_BASE_URL: string;
  EMAIL_FROM: string;
  EMAIL_ENABLED: string;
  PBKDF2_ITERATIONS?: string;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  language: Language;
  must_change_password: boolean;
}

export interface RequestContext {
  env: Env;
  user: SessionUser;
  ip: string;
  lang: Language;
  waitUntil: (p: Promise<unknown>) => void;
}

export type AppVariables = {
  user: SessionUser;
  session_id: string;
  csrf: string;
  ip: string;
  lang: Language;
};
