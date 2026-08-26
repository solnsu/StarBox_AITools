import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, type TomlTable } from 'smol-toml';
import { ServiceError } from './auth-service.js';

export const LOCAL_GATEWAY_PROVIDER = 'myChatgpt';
export const DEEPSEEK_PROVIDER = 'deepseek';
export const CODEX_PROVIDER_DISPLAY_NAME = 'StarBox';

const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const validateCodexProvider = (input: string): string => {
  const provider = input.trim();
  if (!PROVIDER_PATTERN.test(provider)) throw new ServiceError('CODEX_PROVIDER_INVALID', 400);
  return provider;
};

export const readCodexProvider = async (codexHome: string, fallback: string): Promise<string> => {
  try {
    const parsed = parse(await readFile(path.join(codexHome, 'config.toml'), 'utf8')) as TomlTable;
    return typeof parsed.model_provider === 'string'
      ? validateCodexProvider(parsed.model_provider)
      : fallback;
  } catch {
    return fallback;
  }
};
