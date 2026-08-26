export type AvailableModel = {
  id: string;
  displayName: string;
  description: string | null;
  defaultReasoningLevel: string | null;
  supportedReasoningLevels: string[];
};

type CatalogEntry = readonly [id: string, displayName: string];

const FREE_MODELS: CatalogEntry[] = [
  ['gpt-5.4-mini', 'GPT-5.4-Mini'],
  ['gpt-5.5', 'GPT-5.5'],
  ['gpt-5.6-terra', 'GPT-5.6-Terra'],
  ['gpt-5.6-luna', 'GPT-5.6-Luna'],
];

const TEAM_MODELS: CatalogEntry[] = [
  ['gpt-5.4', 'GPT-5.4'],
  ...FREE_MODELS,
  ['gpt-5.6-sol', 'GPT-5.6-Sol'],
];

const PLUS_AND_PRO_MODELS: CatalogEntry[] = [
  ['gpt-5.3-codex-spark', 'GPT-5.3-Codex-Spark'],
  ['gpt-5.4', 'GPT-5.4'],
  ['gpt-5.4-mini', 'GPT-5.4-Mini'],
  ['gpt-5.5', 'GPT-5.5'],
  ['gpt-5.6-sol', 'GPT-5.6-Sol'],
  ['gpt-5.6-terra', 'GPT-5.6-Terra'],
  ['gpt-5.6-luna', 'GPT-5.6-Luna'],
];

const IMAGE_MODELS: CatalogEntry[] = [
  ['gpt-image-1.5', 'GPT Image 1.5'],
  ['gpt-image-2', 'GPT Image 2'],
];

const toModel = ([id, displayName]: CatalogEntry): AvailableModel => ({
  id,
  displayName,
  description: null,
  defaultReasoningLevel: null,
  supportedReasoningLevels: [],
});

const catalogForPlan = (planType: string | null): CatalogEntry[] => {
  switch (planType?.trim().toLowerCase()) {
    case 'free':
      return FREE_MODELS;
    case 'team':
    case 'business':
    case 'go':
      return TEAM_MODELS;
    case 'plus':
    case 'pro':
    default:
      return PLUS_AND_PRO_MODELS;
  }
};

export const mergeCodexModelCatalog = (
  liveModels: AvailableModel[],
  planType: string | null,
): AvailableModel[] => {
  const models = new Map(liveModels.map((model) => [model.id, model]));
  for (const entry of [...catalogForPlan(planType), ...IMAGE_MODELS]) {
    const model = toModel(entry);
    if (!models.has(model.id)) models.set(model.id, model);
  }
  return [...models.values()];
};
