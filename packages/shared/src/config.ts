import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  AUTH_SECRET: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_USE_LIVE: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  AI_DECISION_MODEL: z.string().default('claude-haiku-4-5'),
  AI_DIALOGUE_MODEL: z.string().default('claude-sonnet-5'),
  AI_SUMMARY_MODEL: z.string().default('claude-sonnet-5'),
  AI_PREMIUM_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  AI_DAILY_BUDGET_CENTS: z
    .string()
    .transform((v) => parseInt(v, 10))
    .default('500'),
  GAME_DAY_REAL_SECONDS: z
    .string()
    .transform((v) => parseInt(v, 10))
    .default('300'),
  SIMULATION_TICK_SECONDS: z
    .string()
    .transform((v) => parseInt(v, 10))
    .default('10'),
  DIRECTIVE_MAX_CHARACTERS: z
    .string()
    .transform((v) => parseInt(v, 10))
    .default('500'),
  DEFAULT_STARTING_CURRENCY_CENTS: z
    .string()
    .transform((v) => parseInt(v, 10))
    .default('10000'),
  NEXTAUTH_URL: z.string().url().optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type AppConfig = z.infer<typeof envSchema>;

let _config: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (_config) return _config;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment configuration:');
    console.error(result.error.format());
    process.exit(1);
  }
  _config = result.data;
  return _config;
}

// For use in workers/servers that need the config
export function getConfig(): AppConfig {
  if (!_config) {
    throw new Error('Config not loaded. Call loadConfig() at startup.');
  }
  return _config;
}
