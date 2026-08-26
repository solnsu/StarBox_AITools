import { z } from 'zod';

const idSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/);
const tierSchema = z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/);
const modelPriceSchema = z.object({
  input: z.number().finite().nonnegative(),
  cachedInput: z.number().finite().nonnegative(),
  output: z.number().finite().nonnegative(),
}).strict();
const aliasesSchema = z.record(idSchema, idSchema).default({});
const currencySchema = z.enum(['USD', 'CNY']);
const sourceSchema = z.url().refine((value) => value.startsWith('https://'), 'HTTPS source required');
const providerBaseSchema = z.object({
  aliases: aliasesSchema,
});
const fixedProviderSchema = providerBaseSchema.extend({
  pricingMode: z.literal('fixed'),
  currency: currencySchema,
  source: sourceSchema,
  models: z.record(idSchema, modelPriceSchema),
}).strict();
const timeWindowCurrencySchema = z.object({
  source: sourceSchema,
  models: z.record(idSchema, z.record(tierSchema, modelPriceSchema)),
}).strict();
const timeWindowProviderSchema = providerBaseSchema.extend({
  pricingMode: z.literal('time_window'),
  timezone: z.string().trim().min(1).max(80).refine((value) => {
    try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; } catch { return false; }
  }, 'Invalid IANA timezone'),
  defaultTier: tierSchema,
  windows: z.array(z.object({
    tier: tierSchema,
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  }).strict().refine((window) => window.start < window.end, 'Window start must precede end')).max(20),
  currencies: z.record(currencySchema, timeWindowCurrencySchema),
}).strict();
const providerSchema = z.discriminatedUnion('pricingMode', [fixedProviderSchema, timeWindowProviderSchema]);

const pricingCatalogSchema = z.object({
  version: z.string().trim().min(1).max(64),
  publishedAt: z.iso.datetime({ offset: true }),
  unit: z.literal('per_million_tokens'),
  providers: z.record(idSchema, providerSchema),
}).strict().superRefine((catalog, context) => {
  for (const [providerId, provider] of Object.entries(catalog.providers)) {
    const modelCatalogs = provider.pricingMode === 'fixed'
      ? [provider.models]
      : Object.values(provider.currencies).map((currency) => currency.models);
    for (const [alias, target] of Object.entries(provider.aliases)) {
      if (modelCatalogs.some((models) => !models[target])) {
        context.addIssue({ code: 'custom', path: ['providers', providerId, 'aliases', alias], message: `Unknown pricing target: ${target}` });
      }
    }
    if (provider.pricingMode !== 'time_window') continue;
    const tiers = new Set([provider.defaultTier, ...provider.windows.map((window) => window.tier)]);
    for (const [currency, catalog] of Object.entries(provider.currencies)) {
      for (const [model, prices] of Object.entries(catalog.models)) {
        for (const tier of tiers) {
          if (!prices[tier]) {
            context.addIssue({ code: 'custom', path: ['providers', providerId, 'currencies', currency, 'models', model, tier], message: `Missing pricing tier: ${tier}` });
          }
        }
      }
    }
  }
});

export type ModelPricingCatalog = z.infer<typeof pricingCatalogSchema>;
export type ModelPrice = z.infer<typeof modelPriceSchema>;
export type PricingCurrency = 'USD' | 'CNY';
export type ModelUsage = {
  model: string | null;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
};
export type ProviderModelUsage = ModelUsage & {
  provider: string;
  timestampMs: number;
  billingCurrency?: PricingCurrency;
};
export type EstimatedCost = { amount: number; currency: PricingCurrency };

export const parseModelPricingCatalog = (value: unknown): ModelPricingCatalog => pricingCatalogSchema.parse(value);

const weekdayNumbers: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const activeTier = (
  provider: Extract<ModelPricingCatalog['providers'][string], { pricingMode: 'time_window' }>,
  timestampMs: number,
): string => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: provider.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestampMs));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = weekdayNumbers[value.weekday ?? ''];
  const time = `${value.hour}:${value.minute}`;
  return provider.windows.find((window) => weekday !== undefined
    && window.weekdays.includes(weekday) && time >= window.start && time < window.end)?.tier ?? provider.defaultTier;
};

export const resolveModelPrice = (
  catalog: ModelPricingCatalog,
  model: string | null,
  providerId = 'codex',
  timestampMs = Date.now(),
  billingCurrency?: PricingCurrency,
): ModelPrice | null => {
  if (!model) return null;
  const provider = catalog.providers[providerId];
  if (!provider) return null;
  const resolvedModel = provider.aliases[model] ?? model;
  if (provider.pricingMode === 'fixed') return provider.models[resolvedModel] ?? null;
  if (!billingCurrency) return null;
  const prices = provider.currencies[billingCurrency]?.models[resolvedModel];
  return prices?.[activeTier(provider, timestampMs)] ?? null;
};

export const estimateModelCost = (catalog: ModelPricingCatalog, usage: ProviderModelUsage): EstimatedCost | null => {
  const provider = catalog.providers[usage.provider];
  const price = resolveModelPrice(catalog, usage.model, usage.provider, usage.timestampMs, usage.billingCurrency);
  if (!provider || !price) return null;
  const inputTokens = Math.max(usage.inputTokens, 0);
  const cachedTokens = Math.min(Math.max(usage.cachedTokens, 0), inputTokens);
  const amount = (
    (inputTokens - cachedTokens) * price.input
    + cachedTokens * price.cachedInput
    + Math.max(usage.outputTokens, 0) * price.output
  ) / 1_000_000;
  const currency = provider.pricingMode === 'fixed' ? provider.currency : usage.billingCurrency;
  return currency ? { amount, currency } : null;
};

export const estimateModelCostUsd = (catalog: ModelPricingCatalog, usage: ModelUsage): number =>
  estimateModelCost(catalog, { ...usage, provider: 'codex', timestampMs: Date.now() })?.amount ?? 0;
