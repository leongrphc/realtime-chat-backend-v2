import { z } from 'zod';
const envSchema = z.object({
  DATABASE_URL: z.string().startsWith('postgresql://'),
  REDIS_URL: z.string().regex(/^rediss?:\/\//),
  WEB_ORIGIN: z.url(),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  UPLOADS_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  EDGE_PROXY_SECRET: z.string().min(32).optional(),
  COOKIE_SECURE: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  SESSION_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  S3_ENDPOINT: z.url().optional(), S3_PUBLIC_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1).optional(), S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY: z.string().min(1).optional(), S3_SECRET_KEY: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false').transform(v => v === 'true')
}).superRefine((config, ctx) => {
  if (config.UPLOADS_ENABLED) {
    for (const key of ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] as const) {
      if (!config[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'Required when uploads are enabled' });
    }
  }
});
export type Config = z.infer<typeof envSchema>;
export const readConfig = (env: NodeJS.ProcessEnv = process.env): Config => envSchema.parse({ ...env, API_PORT: env.PORT ?? env.API_PORT });
