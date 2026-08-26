import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, RefreshCw, X } from 'lucide-react';
import {
  ApiError, deepSeekApi, gatewayApi, modelsApi,
  type ClientConfiguration, type DeepSeekCodexConfiguration, type DeepSeekHarnessConfiguration,
} from './api';
import { errorKey, useI18n } from './i18n';
import { SolnSpin } from './SolnSpin';
import { MotionPresence } from './MotionPresence';
import { CustomSelect, type CustomSelectOption } from './CustomSelect';
import type { AvailableModel, Notice } from './types';

type Notify = (message: string, type?: Notice['type']) => void;
type DeepSeekApplyDestination = 'codex' | 'harness';

export function ModelConfigDialog({ model, deepSeekKeyId, notify, onClose }: {
  model: AvailableModel;
  deepSeekKeyId?: string;
  notify: Notify;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [config, setConfig] = useState<ClientConfiguration | DeepSeekHarnessConfiguration | null>(null);
  const [deepSeekCodexConfig, setDeepSeekCodexConfig] = useState<DeepSeekCodexConfiguration | null>(null);
  const [loading, setLoading] = useState(true);
  const [rotating, setRotating] = useState(false);
  const [applyingTarget, setApplyingTarget] = useState<'local-codex' | 'deepseek-harness' | 'deepseek-codex' | null>(null);
  const [deepSeekDestination, setDeepSeekDestination] = useState<DeepSeekApplyDestination>('harness');
  const [provider, setProvider] = useState('');
  const [confirmingRotation, setConfirmingRotation] = useState(false);
  const [copiedTarget, setCopiedTarget] = useState<string | null>(null);
  const copiedTimer = useRef<number | null>(null);
  const providerValid = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(provider.trim());

  const load = useCallback(async () => {
    setLoading(true);
    setDeepSeekCodexConfig(null);
    setProvider('');
    if (deepSeekKeyId) setDeepSeekDestination('harness');
    try {
      if (!deepSeekKeyId) {
        const next = await modelsApi.clientConfig(model.id);
        setConfig(next);
        setProvider(next.provider ?? '');
        return;
      }
      const [harnessResult, codexResult] = await Promise.allSettled([
        deepSeekApi.harnessConfig(deepSeekKeyId, model.id),
        deepSeekApi.codexConfig(deepSeekKeyId, model.id),
      ]);
      if (harnessResult.status === 'rejected') throw harnessResult.reason;
      setConfig(harnessResult.value);
      if (codexResult.status === 'fulfilled') {
        setDeepSeekCodexConfig(codexResult.value);
        setProvider(codexResult.value.provider);
      }
      else {
        setDeepSeekDestination('harness');
        if (!(codexResult.reason instanceof ApiError && codexResult.reason.code === 'DEEPSEEK_CODEX_MODEL_UNSUPPORTED')) {
          notify(t(errorKey(codexResult.reason instanceof ApiError ? codexResult.reason.code : '')), 'error');
        }
      }
    } catch (error) {
      notify(t(errorKey(error instanceof ApiError ? error.code : '')), 'error');
    } finally {
      setLoading(false);
    }
  }, [deepSeekKeyId, model.id, notify, t]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => {
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
  }, []);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (event.defaultPrevented || document.querySelector('.custom-select-menu')) return;
      if (confirmingRotation) setConfirmingRotation(false);
      else onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [confirmingRotation, onClose]);

  const copy = async (content: string, target: string) => {
    try {
      await navigator.clipboard.writeText(content);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      setCopiedTarget(target);
      copiedTimer.current = window.setTimeout(() => {
        setCopiedTarget(null);
        copiedTimer.current = null;
      }, 1800);
      notify(t('copied'));
    } catch {
      notify(t('errorGeneric'), 'error');
    }
  };

  const rotate = async () => {
    if (deepSeekKeyId) return;
    setConfirmingRotation(false);
    setRotating(true);
    try {
      await gatewayApi.rotateKey();
      const next = await modelsApi.clientConfig(model.id);
      setConfig(next);
      notify(t('apiKeyRotated'));
    } catch (error) {
      notify(t(errorKey(error instanceof ApiError ? error.code : '')), 'error');
    } finally {
      setRotating(false);
    }
  };

  const applyToCodex = async () => {
    setApplyingTarget('local-codex');
    try {
      await modelsApi.applyToCodex(model.id, provider);
      notify(t('codexApplied'));
    } catch (error) {
      notify(t(errorKey(error instanceof ApiError ? error.code : '')), 'error');
    } finally {
      setApplyingTarget(null);
    }
  };

  const applyDeepSeekConfiguration = async () => {
    if (!deepSeekKeyId) return;
    if (deepSeekDestination === 'codex' && !deepSeekCodexConfig) return;
    const target = deepSeekDestination === 'codex' ? 'deepseek-codex' : 'deepseek-harness';
    setApplyingTarget(target);
    try {
      if (deepSeekDestination === 'codex') {
        await deepSeekApi.applyToCodex(deepSeekKeyId, model.id, provider);
        notify(t('deepSeekCodexApplied'));
      } else {
        await deepSeekApi.applyToHarness(deepSeekKeyId, model.id);
        notify(t('deepSeekHarnessApplied'));
      }
    } catch (error) {
      notify(t(errorKey(error instanceof ApiError ? error.code : '')), 'error');
    } finally {
      setApplyingTarget(null);
    }
  };

  const refreshProviderPreview = async () => {
    const normalized = provider.trim();
    if (!providerValid) {
      if (normalized) notify(t('errorCodexProviderInvalid'), 'error');
      return;
    }
    try {
      if (deepSeekKeyId && deepSeekCodexConfig) {
        const next = await deepSeekApi.codexConfig(deepSeekKeyId, model.id, normalized);
        setDeepSeekCodexConfig(next);
        setProvider(next.provider);
      } else if (config?.kind === 'codex') {
        const next = await modelsApi.clientConfig(model.id, normalized);
        setConfig(next);
        setProvider(next.provider ?? normalized);
      }
    } catch (error) {
      notify(t(errorKey(error instanceof ApiError ? error.code : '')), 'error');
    }
  };

  const deepSeekDestinations: CustomSelectOption[] = [
    ...(deepSeekCodexConfig ? [{ value: 'codex', label: 'Codex', icon: <CodexMark /> }] : []),
    { value: 'harness', label: 'DeepSeek Harness', icon: <DeepSeekMark /> },
  ];

  return <div className="model-config-layer" role="dialog" aria-modal="true" aria-label={t('modelConfigTitle')}>
    <button className="model-config-backdrop" aria-label={t('close')} onClick={onClose} />
    <section className="model-config-dialog">
      <header className="model-config-header">
        <div className="model-config-title-row">
          <h3>{t('useModel', { model: model.displayName })}</h3>
          {config?.kind === 'codex' && <button className="model-config-apply-client" type="button" onClick={() => void applyToCodex()} disabled={applyingTarget !== null || loading || !providerValid} aria-label={t('applyToCodex')} title={t('applyToCodex')}>
            {applyingTarget === 'local-codex' ? <SolnSpin label={t('applying')} /> : <CodexMark />}
            <span>{applyingTarget === 'local-codex' ? t('applying') : t('applyToCodex')}</span>
          </button>}
          {config?.kind === 'deepseek-harness' ? <>
            <span className="model-config-apply-label">{t('applyTo')}</span>
            <CustomSelect
              className="model-config-destination-select"
              value={deepSeekDestination}
              options={deepSeekDestinations}
              onChange={(value) => setDeepSeekDestination(value as DeepSeekApplyDestination)}
              ariaLabel={t('applyDestination')}
              disabled={applyingTarget !== null || loading}
              icon={deepSeekDestination === 'codex' ? <CodexMark /> : <DeepSeekMark />}
              tone="dark"
              menuPlacement="bottom"
              minMenuWidth={220}
            />
            <button className="model-config-apply-confirm" type="button" onClick={() => void applyDeepSeekConfiguration()} disabled={applyingTarget !== null || loading || (deepSeekDestination === 'codex' && !providerValid)}>
              {applyingTarget === 'deepseek-codex' || applyingTarget === 'deepseek-harness' ? <SolnSpin label={t('applying')} /> : null}
              <span>{applyingTarget === 'deepseek-codex' || applyingTarget === 'deepseek-harness' ? t('applying') : t('confirmApply')}</span>
            </button>
          </> : null}
        </div>
        <button className="model-config-close" aria-label={t('close')} onClick={onClose}><X size={21} /></button>
      </header>
      {loading ? <div className="model-config-loading"><SolnSpin label={t('loading')} /></div> : config ? <div className="model-config-content cp-sidebar-scrollbar">
        <section className="model-config-secret">
          <div className="model-config-section-title"><div><span>{t('apiKey')}</span></div>{config.kind !== 'deepseek-harness' ? <button onClick={() => setConfirmingRotation(true)} disabled={rotating}><RefreshCw className={rotating ? 'spin' : ''} size={14} />{t('rotateKey')}</button> : null}</div>
          {config.kind === 'deepseek-harness'
            ? <div className="model-config-copy-row static"><code>{config.maskedKey}</code></div>
            : <div className="model-config-copy-row"><code>{config.apiKey}</code><button className={copiedTarget === 'api-key' ? 'copied' : ''} aria-label={copiedTarget === 'api-key' ? t('copied') : t('copy')} title={copiedTarget === 'api-key' ? t('copied') : t('copy')} onClick={() => void copy(config.apiKey, 'api-key')}>{copiedTarget === 'api-key' ? <Check size={16} strokeWidth={2.5} /> : <Copy size={15} />}</button></div>}
        </section>
        <div className={`model-config-connection${config.kind === 'codex' || deepSeekCodexConfig ? ' with-provider' : ''}`}>
          <section className="model-config-endpoint">
            <span>{t('localApiEndpoint')}</span>
            <div className="model-config-copy-row"><code>{config.endpoint}</code><button className={copiedTarget === 'endpoint' ? 'copied' : ''} aria-label={copiedTarget === 'endpoint' ? t('copied') : t('copy')} title={copiedTarget === 'endpoint' ? t('copied') : t('copy')} onClick={() => void copy(config.endpoint, 'endpoint')}>{copiedTarget === 'endpoint' ? <Check size={16} strokeWidth={2.5} /> : <Copy size={15} />}</button></div>
          </section>
          {config.kind === 'codex' || deepSeekCodexConfig ? <label className="model-config-provider">
            <span>{t('codexProviderName')}</span>
            <input
              value={provider}
              maxLength={64}
              spellCheck={false}
              autoComplete="off"
              placeholder={t('codexProviderPlaceholder')}
              onChange={(event) => setProvider(event.target.value)}
              onBlur={() => void refreshProviderPreview()}
            />
          </label> : null}
        </div>
        {config.kind === 'deepseek-harness' ? <>
          {deepSeekDestination === 'codex' && deepSeekCodexConfig ? <>
            <section className="model-config-endpoint">
              <span>{t('deepSeekCodexHome')}</span>
              <div className="model-config-copy-row"><code>{deepSeekCodexConfig.codexHome}</code><button className={copiedTarget === 'codex-home' ? 'copied' : ''} aria-label={copiedTarget === 'codex-home' ? t('copied') : t('copy')} title={copiedTarget === 'codex-home' ? t('copied') : t('copy')} onClick={() => void copy(deepSeekCodexConfig.codexHome, 'codex-home')}>{copiedTarget === 'codex-home' ? <Check size={16} strokeWidth={2.5} /> : <Copy size={15} />}</button></div>
            </section>
            <div className="model-config-files">
              <ConfigFile name="config.toml" content={deepSeekCodexConfig.configToml} copied={copiedTarget === 'file:config.toml'} onCopy={(content) => copy(content, 'file:config.toml')} />
            </div>
            <p className="model-config-secret-note">{t('deepSeekCodexCatalogHint')}</p>
          </> : <>
            <section className="model-config-endpoint">
              <span>{t('deepSeekHarnessHome')}</span>
              <div className="model-config-copy-row"><code>{config.harnessHome}</code><button className={copiedTarget === 'harness-home' ? 'copied' : ''} aria-label={copiedTarget === 'harness-home' ? t('copied') : t('copy')} title={copiedTarget === 'harness-home' ? t('copied') : t('copy')} onClick={() => void copy(config.harnessHome, 'harness-home')}>{copiedTarget === 'harness-home' ? <Check size={16} strokeWidth={2.5} /> : <Copy size={15} />}</button></div>
            </section>
            <div className="model-config-files">
              <ConfigFile name="settings.yaml" content={config.settingsYaml} copied={copiedTarget === 'file:settings.yaml'} onCopy={(content) => copy(content, 'file:settings.yaml')} />
            </div>
            <p className="model-config-secret-note">{t('deepSeekHarnessCredentialHint')}</p>
          </>}
        </> : <div className="model-config-files">
          <ConfigFile name="auth.json" content={config.authJson} compact copied={copiedTarget === 'file:auth.json'} onCopy={(content) => copy(content, 'file:auth.json')} />
          <ConfigFile name={config.secondaryFileName} content={config.secondaryContent} copied={copiedTarget === `file:${config.secondaryFileName}`} onCopy={(content) => copy(content, `file:${config.secondaryFileName}`)} />
        </div>}
      </div> : <div className="model-config-loading"><button className="model-config-retry" onClick={() => void load()}>{t('refresh')}</button></div>}
      <MotionPresence>{confirmingRotation ? <div className="model-key-confirm-layer" role="alertdialog" aria-modal="true" aria-label={t('rotateKeyTitle')}>
        <button className="model-key-confirm-backdrop" aria-label={t('cancel')} onClick={() => setConfirmingRotation(false)} />
        <section className="model-key-confirm">
          <h4>{t('rotateKeyTitle')}</h4>
          <p>{t('rotateKeyBody')}</p>
          <footer><button onClick={() => setConfirmingRotation(false)}>{t('cancel')}</button><button className="confirm" onClick={() => void rotate()}>{t('confirmRotate')}</button></footer>
        </section>
      </div> : null}</MotionPresence>
    </section>
  </div>;
}

function CodexMark() {
  return <svg className="codex-mark" fill="#fff" fillRule="evenodd" style={{ flex: 'none', lineHeight: 1 }} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <title>Codex</title>
    <path clipRule="evenodd" d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z" />
  </svg>;
}

function DeepSeekMark() {
  return <svg className="deepseek-mark" xmlns="http://www.w3.org/2000/svg" style={{ flex: 'none', lineHeight: 1 }} viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4D6BFE" d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 0 1-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 0 0-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 0 1-.465.137 9.597 9.597 0 0 0-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 0 0 1.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 0 1 1.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 0 1 .415-.287.302.302 0 0 1 .2.288.306.306 0 0 1-.31.307.303.303 0 0 1-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 0 1-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 0 1 .016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 0 1-.254-.078.253.253 0 0 1-.114-.358c.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z" />
  </svg>;
}

function ConfigFile({ name, content, compact = false, copied, onCopy }: {
  name: string;
  content: string;
  compact?: boolean;
  copied: boolean;
  onCopy: (content: string) => Promise<void>;
}) {
  const { t } = useI18n();
  return <section className={`model-config-file${compact ? ' compact' : ''}${name === 'request.json' ? ' image-request' : ''}${name === 'config.toml' ? ' config-toml' : ''}`}>
    <strong className="model-config-file-name">{name}</strong>
    <div className="model-config-code-wrap">
      <pre className="model-config-code cp-sidebar-scrollbar"><code>{content}</code></pre>
      <button className={`model-config-code-copy${copied ? ' copied' : ''}`} aria-label={copied ? t('copied') : t('copy')} title={copied ? t('copied') : t('copy')} onClick={() => void onCopy(content)}>{copied ? <Check size={16} strokeWidth={2.5} /> : <Copy size={14} />}</button>
    </div>
  </section>;
}
