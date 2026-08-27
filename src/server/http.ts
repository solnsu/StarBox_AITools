import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AuthService } from './services/auth-service.js';
import { ServiceError } from './services/auth-service.js';
import type { GatewayService } from './services/gateway-service.js';
import { CodexClientService } from './services/codex-client-service.js';
import { CodexRateLimitService } from './services/codex-rate-limit-service.js';
import type { CreationService } from './services/creation-service.js';
import type { DesktopIntegration } from './desktop-integration.js';
import type { DeepSeekKeyService } from './services/deepseek-key-service.js';
import type { DeepSeekModelService } from './services/deepseek-model-service.js';
import type { DeepSeekBalanceService } from './services/deepseek-balance-service.js';
import type { DeepSeekHarnessService } from './services/deepseek-harness-service.js';
import type { DeepSeekCodexService } from './services/deepseek-codex-service.js';
import type { DeepSeekProxyService } from './services/deepseek-proxy-service.js';

const importSchema = z
  .object({
    fileName: z.string().min(1).max(180),
    content: z.union([z.string().min(2), z.record(z.string(), z.unknown())]),
  })
  .strict();

const statusSchema = z.object({ disabled: z.boolean() }).strict();
const gatewaySettingsSchema = z.object({
  baseUrl: z.string().min(1).max(500),
  enabled: z.boolean().default(true),
}).strict();
const codexProviderSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const clientConfigSchema = z.object({
  model: z.string().min(1).max(120),
  provider: codexProviderSchema.optional(),
}).strict();
const codexApplySchema = z.object({
  model: z.string().min(1).max(120),
  provider: codexProviderSchema,
}).strict();
const creationGenerateSchema = z.object({
  authFileId: z.string().uuid(),
  sessionId: z.string().uuid(),
  session: z.object({
    id: z.string().uuid(),
    title: z.string().min(1).max(200),
    createdAt: z.number().int().positive(),
  }).strict(),
  userMessage: z.object({
    id: z.string().uuid(),
    role: z.literal('user'),
    text: z.string().max(32_000),
    attachments: z.array(z.object({ name: z.string().min(1).max(240), dataUrl: z.string().regex(/^data:image\/(?:png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/).max(15 * 1024 * 1024) }).strict()).max(4).optional(),
    createdAt: z.number().int().positive(),
  }).strict().optional(),
  model: z.string().min(1).max(120),
  prompt: z.string().min(1).max(32_000),
  size: z.enum(['auto', '1024x1024', '1536x1024', '1024x1536']).default('auto'),
  quality: z.enum(['auto', 'low', 'medium', 'high']).default('auto'),
  inputImages: z.array(z.string().regex(/^data:image\/(?:png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/).max(15 * 1024 * 1024)).max(4).optional(),
}).strict().refine((input) => input.session.id === input.sessionId);
const creationSessionSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(200),
  createdAt: z.number().int().positive(),
}).strict();
const creationSessionTitleSchema = z.object({ title: z.string().min(1).max(200) }).strict();
const creationMessageSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(['assistant', 'user']),
  text: z.string().max(32_000),
  kind: z.literal('error').optional(),
  attachments: z.array(z.object({
    name: z.string().min(1).max(240),
    url: z.string().startsWith('/api/generated-images/').max(500),
  }).strict()).max(8).optional(),
  inputAttachments: z.array(z.object({ name: z.string().min(1).max(240), dataUrl: z.string().regex(/^data:image\/(?:png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/).max(15 * 1024 * 1024) }).strict()).max(4).optional(),
  retryDraft: z.object({ text: z.string().max(32_000), model: z.string().max(120), size: z.string().max(20).optional(), quality: z.string().max(20).optional(), inputImages: z.array(z.string().max(15 * 1024 * 1024)).max(4).optional() }).strict().optional(),
  createdAt: z.number().int().positive(),
}).strict();
const authOrderSchema = z.object({ ids: z.array(z.string().min(1)).min(1) }).strict();
const rateLimitResetSchema = z.object({ idempotencyKey: z.string().uuid() }).strict();
const deepSeekKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  apiKey: z.string().trim().min(1).max(512),
  billingCurrency: z.enum(['CNY', 'USD']),
}).strict();
const deepSeekModelsQuerySchema = z.object({ keyId: z.string().uuid() }).strict();
const deepSeekHarnessSchema = z.object({
  keyId: z.string().uuid(),
  model: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/),
}).strict();
const deepSeekCodexSchema = deepSeekHarnessSchema.extend({
  provider: codexProviderSchema.optional(),
}).strict();
const deepSeekCodexApplySchema = deepSeekHarnessSchema.extend({
  provider: codexProviderSchema,
}).strict();

const queryString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const chatGptLoginError = (error: unknown): ServiceError => {
  const code = error instanceof Error ? error.message : '';
  const statuses: Record<string, number> = {
    CODEX_CLI_NOT_FOUND: 503,
    CHATGPT_LOGIN_IN_PROGRESS: 409,
    CHATGPT_LOGIN_CANCELLED: 409,
    CHATGPT_LOGIN_TIMEOUT: 408,
    CHATGPT_AUTH_FILE_MISSING: 502,
    CHATGPT_LOGIN_FAILED: 502,
  };
  return new ServiceError(code in statuses ? code : 'CHATGPT_LOGIN_FAILED', statuses[code] ?? 502);
};

export const createHttpApp = (
  service: AuthService,
  gatewayService: GatewayService,
  webDir: string,
  creationService: CreationService,
  deepSeekKeyService: DeepSeekKeyService,
  deepSeekModelService: DeepSeekModelService,
  deepSeekBalanceService: DeepSeekBalanceService,
  deepSeekHarnessService: DeepSeekHarnessService,
  deepSeekCodexService: DeepSeekCodexService,
  deepSeekProxyService: DeepSeekProxyService,
  codexClientService = new CodexClientService(gatewayService),
  desktopIntegration: DesktopIntegration = {},
  codexRateLimitService: Pick<CodexRateLimitService, 'read' | 'consume'> = new CodexRateLimitService(service),
) => {
  const app = express();
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(express.json({ limit: '50mb' }));

  app.post([
    '/deepseek/:keyId/responses',
    '/deepseek/:keyId/v1/responses',
    '/deepseek/:keyId/chat/completions',
    '/deepseek/:keyId/v1/chat/completions',
  ], async (request, response) => {
    const keyId = z.string().uuid().parse(request.params.keyId);
    const endpoint = request.path.endsWith('/chat/completions') ? 'chat/completions' : 'responses';
    const stream = Boolean(request.body && typeof request.body === 'object' && request.body.stream === true);
    const context = await deepSeekProxyService.proxy(
      keyId, endpoint, request.body, request.header('authorization'),
    );
    const status = context.response.status;
    response.status(status);
    response.setHeader('X-Request-Id', context.requestId);
    if (!context.response.body) {
      deepSeekProxyService.record(context, '', status, null);
      response.end();
      return;
    }
    const reader = context.response.body.getReader();
    let captured = '';
    let ttftMs: number | null = null;
    if (stream && context.response.ok) {
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      response.setHeader('Cache-Control', 'no-cache');
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (ttftMs === null && value.byteLength) ttftMs = Date.now() - context.startedAt;
        captured = deepSeekProxyService.captureAppend(captured, value);
        response.write(Buffer.from(value));
      }
      deepSeekProxyService.record(context, captured, status, ttftMs);
      response.end();
      return;
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ttftMs === null && value.byteLength) ttftMs = Date.now() - context.startedAt;
      captured = deepSeekProxyService.captureAppend(captured, value);
    }
    deepSeekProxyService.record(context, captured, status, ttftMs);
    response.type(context.response.headers.get('content-type') ?? 'application/json').send(captured);
  });

  app.get('/api/health', (_request, response) => response.json({ status: 'ok' }));
  app.get('/api/deepseek/keys', (_request, response) => {
    response.json({ keys: deepSeekKeyService.list() });
  });
  app.post('/api/deepseek/keys', async (request, response) => {
    const input = deepSeekKeySchema.parse(request.body);
    response.status(201).json({
      key: await deepSeekKeyService.create(input.name, input.apiKey, input.billingCurrency),
    });
  });
  app.patch('/api/deepseek/keys/order', (request, response) => {
    response.json({ keys: deepSeekKeyService.reorder(authOrderSchema.parse(request.body).ids) });
  });
  app.delete('/api/deepseek/keys/:id', (request, response) => {
    deepSeekKeyService.delete(z.string().uuid().parse(request.params.id));
    response.status(204).end();
  });
  app.get('/api/deepseek/models', async (request, response) => {
    const input = deepSeekModelsQuerySchema.parse({ keyId: queryString(request.query.keyId) });
    response.json(await deepSeekModelService.list(input.keyId));
  });
  app.get('/api/deepseek/balance', async (request, response) => {
    const input = deepSeekModelsQuerySchema.parse({ keyId: queryString(request.query.keyId) });
    response.json(await deepSeekBalanceService.read(input.keyId));
  });
  app.post('/api/deepseek/harness-config', (request, response) => {
    const input = deepSeekHarnessSchema.parse(request.body);
    response.json(deepSeekHarnessService.configuration(input.keyId, input.model));
  });
  app.post('/api/deepseek/harness-apply', async (request, response) => {
    const input = deepSeekHarnessSchema.parse(request.body);
    response.json(await deepSeekHarnessService.apply(input.keyId, input.model));
  });
  app.post('/api/deepseek/codex-config', async (request, response) => {
    const input = deepSeekCodexSchema.parse(request.body);
    response.json(await deepSeekCodexService.configuration(input.keyId, input.model, input.provider));
  });
  app.post('/api/deepseek/codex-apply', async (request, response) => {
    const input = deepSeekCodexApplySchema.parse(request.body);
    response.json(await deepSeekCodexService.apply(input.keyId, input.model, input.provider));
  });
  app.post('/api/generated-images/open-directory', async (_request, response) => {
    if (!desktopIntegration.openGeneratedImagesDirectory) {
      throw new ServiceError('DESKTOP_INTEGRATION_UNAVAILABLE', 501);
    }
    await desktopIntegration.openGeneratedImagesDirectory();
    response.json({ opened: true });
  });
  app.get('/api/generated-images/:id', (request, response) => {
    const image = creationService.imageFile(request.params.id);
    response.setHeader('Content-Type', image.mimeType);
    response.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    response.sendFile(image.filePath);
  });
  app.get('/api/creation-input-images/:id', (request, response) => {
    const image = creationService.inputImageFile(request.params.id);
    response.setHeader('Content-Type', image.mimeType);
    response.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    response.sendFile(image.filePath);
  });
  app.get('/api/creation/workspace', async (_request, response) => response.json(await creationService.workspace()));
  app.post('/api/creation/sessions', (request, response) => {
    response.status(201).json({ session: creationService.createSession(creationSessionSchema.parse(request.body)) });
  });
  app.patch('/api/creation/sessions/:id', (request, response) => {
    creationService.renameSession(request.params.id, creationSessionTitleSchema.parse(request.body).title);
    response.status(204).end();
  });
  app.delete('/api/creation/sessions/:id', async (request, response) => {
    await creationService.deleteSession(request.params.id);
    response.status(204).end();
  });
  app.post('/api/creation/sessions/:id/messages', async (request, response) => {
    const message = creationMessageSchema.parse(request.body);
    await creationService.addMessage(request.params.id, message);
    response.status(201).json({ saved: true });
  });
  app.get('/api/gateway-settings', (_request, response) => response.json({ settings: gatewayService.getSettings() }));
  app.put('/api/gateway-settings', (request, response) => {
    response.json(gatewayService.saveSettings(gatewaySettingsSchema.parse(request.body)));
  });
  app.post('/api/gateway-settings/rotate-key', (_request, response) => {
    response.json(gatewayService.rotateApiKey());
  });
  app.post('/api/client-config', async (request, response) => {
    const input = clientConfigSchema.parse(request.body);
    response.json(await codexClientService.configuration(input.model, input.provider));
  });
  app.post('/api/codex-client/apply', async (request, response) => {
    const input = codexApplySchema.parse(request.body);
    response.json(await codexClientService.apply(input.model, input.provider));
  });
  app.get('/api/models', async (request, response) => {
    response.json(await service.listAvailableModels(queryString(request.query.authFileId)));
  });
  app.get('/api/client-files/auth.json', (_request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="auth.json"');
    response.send(gatewayService.buildAuthJson());
  });
  app.get('/api/client-files/config.toml', (request, response) => {
    const model = queryString(request.query.model);
    if (!model) throw new ServiceError('MODEL_REQUIRED', 400);
    response.setHeader('Content-Type', 'application/toml; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="config.toml"');
    response.send(gatewayService.buildConfigToml(model));
  });
  app.get('/api/request-logs', (request, response) => {
    const rawStatus = queryString(request.query.status);
    const status = rawStatus === 'failed' || rawStatus === 'success' ? rawStatus : 'all';
    const rawLimit = Number(queryString(request.query.limit) ?? 100);
    const rawOffset = Number(queryString(request.query.offset) ?? 0);
    const rawBefore = Number(queryString(request.query.before) ?? 0);
    const rawStartAt = Number(queryString(request.query.startAt) ?? 0);
    const rawEndAt = Number(queryString(request.query.endAt) ?? 0);
    response.json(gatewayService.dashboard({
      query: queryString(request.query.query),
      accountId: queryString(request.query.accountId),
      status,
      limit: Number.isFinite(rawLimit) ? rawLimit : 100,
      offset: Number.isFinite(rawOffset) && rawOffset > 0 ? Math.trunc(rawOffset) : 0,
      before: Number.isFinite(rawBefore) && rawBefore > 0 ? rawBefore : undefined,
      startAt: Number.isFinite(rawStartAt) && rawStartAt > 0 ? rawStartAt : undefined,
      endAt: Number.isFinite(rawEndAt) && rawEndAt > 0 ? rawEndAt : undefined,
    }));
  });
  app.get('/v1/models', async (request, response) => {
    gatewayService.authorize(request.header('authorization'));
    const result = await service.listAvailableModels();
    response.json({
      object: 'list',
      data: result.models.map((model) => ({
        id: model.id, object: 'model', owned_by: 'openai',
      })),
    });
  });
  app.post('/v1/responses', async (request, response) => {
    const stream = Boolean(request.body && typeof request.body === 'object' && request.body.stream === true);
    const context = await gatewayService.proxyResponses(request.body, request.header('authorization'));
    const status = context.response.status;
    response.status(status);
    response.setHeader('X-Request-Id', context.requestId);
    if (!context.response.body) {
      gatewayService.record(context, '', status);
      response.end();
      return;
    }
    const reader = context.response.body.getReader();
    let captured = '';
    let ttftMs: number | null = null;
    if (stream && context.response.ok) {
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      response.setHeader('Cache-Control', 'no-cache');
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (ttftMs === null && value.byteLength > 0) ttftMs = Date.now() - context.startedAt;
        captured = gatewayService.captureAppend(captured, value);
        response.write(Buffer.from(value));
      }
      gatewayService.record(context, captured, status, ttftMs);
      response.end();
      return;
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ttftMs === null && value.byteLength > 0) ttftMs = Date.now() - context.startedAt;
      captured = gatewayService.captureAppend(captured, value);
    }
    gatewayService.record(context, captured, status, ttftMs);
    const completed = context.response.ok ? gatewayService.extractCompletedResponse(captured) : null;
    response.type('application/json').send(completed ?? captured);
  });
  app.post('/v1/images/generations', async (request, response) => {
    const context = await gatewayService.proxyImageGeneration(request.body, request.header('authorization'));
    const status = context.response.status;
    const captured = await context.response.text();
    gatewayService.recordImage(context, captured, status);
    response.status(status);
    response.setHeader('X-Request-Id', context.requestId);
    response.setHeader('Content-Type', context.response.headers.get('content-type') ?? 'application/json; charset=utf-8');
    response.send(captured);
  });
  app.post('/api/creation/generate', async (request, response) => {
    const input = creationGenerateSchema.parse(request.body);
    await creationService.prepareGeneration(input.session, input.userMessage);
    const context = await gatewayService.proxyManagedImageGeneration({
      model: input.model,
      prompt: input.prompt,
      size: input.size,
      quality: input.quality,
      ...(input.inputImages?.length ? { input_images: input.inputImages } : {}),
    }, input.authFileId);
    const status = context.response.status;
    const captured = await context.response.text();
    if (!context.response.ok) {
      gatewayService.recordImage(context, captured, status);
      response.status(status);
      response.setHeader('X-Request-Id', context.requestId);
      response.setHeader('Content-Type', context.response.headers.get('content-type') ?? 'application/json; charset=utf-8');
      response.send(captured);
      return;
    }
    let result;
    try {
      result = await creationService.saveGeneration(input.sessionId, input.prompt, captured);
    } catch (error) {
      const failure = error instanceof ServiceError ? error : new ServiceError('CREATION_IMAGE_SAVE_FAILED', 500);
      gatewayService.recordImage(context, captured, failure.status, failure.code);
      throw error;
    }
    gatewayService.recordImage(context, captured, status);
    response.status(200);
    response.setHeader('X-Request-Id', context.requestId);
    response.json(result);
  });
  app.get('/api/auth-files', (_request, response) => response.json({ files: service.list() }));
  app.get('/api/auth-files/:id/rate-limit-reset', async (request, response) => {
    response.json(await codexRateLimitService.read(request.params.id));
  });
  app.post('/api/auth-files/:id/rate-limit-reset', async (request, response) => {
    const input = rateLimitResetSchema.parse(request.body);
    response.json(await codexRateLimitService.consume(request.params.id, input.idempotencyKey));
  });
  app.post('/api/auth-files/login-chatgpt/cancel', (_request, response) => {
    if (!desktopIntegration.cancelChatGptLogin) {
      throw new ServiceError('DESKTOP_INTEGRATION_UNAVAILABLE', 501);
    }
    desktopIntegration.cancelChatGptLogin();
    response.json({ cancelled: true });
  });
  app.post('/api/auth-files/login-chatgpt', async (_request, response) => {
    if (!desktopIntegration.loginWithChatGpt) {
      throw new ServiceError('DESKTOP_INTEGRATION_UNAVAILABLE', 501);
    }
    try {
      const credential = await desktopIntegration.loginWithChatGpt();
      response.status(201).json({ file: service.import(credential.fileName, credential.content) });
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw chatGptLoginError(error);
    }
  });
  app.post('/api/auth-files/import', (request, response) => {
    const input = importSchema.parse(request.body);
    response.status(201).json({ file: service.import(input.fileName, input.content) });
  });
  app.get('/api/auth-files/:id/download', (request, response) => {
    const result = service.download(request.params.id);
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
    );
    response.send(result.content);
  });
  app.patch('/api/auth-files/:id/status', (request, response) => {
    const input = statusSchema.parse(request.body);
    response.json({ file: service.setDisabled(request.params.id, input.disabled) });
  });
  app.delete('/api/auth-files/:id', (request, response) => {
    service.delete(request.params.id);
    response.status(204).end();
  });
  app.patch('/api/auth-files/order', (request, response) => {
    response.json({ files: service.reorder(authOrderSchema.parse(request.body).ids) });
  });
  app.post('/api/auth-files/:id/inspect', async (request, response) => {
    response.json({ inspection: await service.inspect(request.params.id) });
  });
  app.post('/api/monitoring/inspect', async (_request, response) => {
    response.json(await service.inspectAll());
  });
  app.get('/api/monitoring', (_request, response) => response.json({ files: service.list() }));

  if (existsSync(webDir)) {
    app.use(express.static(webDir, { index: false }));
    app.use((request, response, next) => {
      if (request.method === 'GET' && request.accepts('html')) {
        response.sendFile(path.join(webDir, 'index.html'));
        return;
      }
      next();
    });
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ServiceError) {
      response.status(error.status).json({ error: { code: error.code, message: error.detail } });
      return;
    }
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: { code: 'INVALID_REQUEST' } });
      return;
    }
    if ((error as { type?: string })?.type === 'entity.too.large') {
      response.status(413).json({ error: { code: 'AUTH_FILE_TOO_LARGE' } });
      return;
    }
    console.error(error);
    response.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
  });
  return app;
};
