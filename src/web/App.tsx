import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Activity, ArrowDown, ArrowUp, ArrowUpRight, BadgeCheck, Bot, CalendarDays, Check, CheckCircle2, ChevronDown, Clipboard, Clock3, Code2, Copy, Download, FileKey2, FileJson2, FileText, FolderOpen, Gauge, KeyRound, Languages, List, LoaderCircle, Menu, MessageCircle, Monitor, MousePointerClick, Plus, Power, PowerOff, ReceiptText, RefreshCw, RotateCw, Save, Search, Server, ShieldCheck, SlidersHorizontal, Sparkles, Trash2, Upload, UserRound, X, Zap } from 'lucide-react';
import {
  ApiError, authApi, creationApi, deepSeekApi, gatewayApi, modelsApi, monitoringApi,
  type CreationImageData, type CreationMessageData, type CreationSessionData,
} from './api';
import { errorKey, useI18n, type TranslationKey } from './i18n';
import type { AuthFile, AvailableModel, BillingCurrency, DeepSeekApiKey, DeepSeekBalance, GatewaySettings, InspectionStatus, Notice, RequestLog, RequestLogSummary, RequestTrendPoint } from './types';
import chatGptRobot from './assets/chatgpt-robot.png';
import deepSeekAssistant from './assets/deepseek-character.png';
import { AssistantComposer, type ImageQuality, type ImageSize } from './AssistantComposer';
import { LogsPreview } from './LogsPreview';
import { ModelConfigDialog } from './ModelConfigDialog';
import MorphSlider, { type MorphTransition } from './MorphSlider';
import { MotionPresence } from './MotionPresence';
import { SolnSpin } from './SolnSpin';
import { DesktopTitlebar } from './DesktopTitlebar';
import { CustomSelect } from './CustomSelect';

type Page = 'home' | 'auth' | 'create' | 'monitor' | 'models' | 'logs';
type Provider = 'codex' | 'deepseek';
type DeepSeekCredentialStatus = 'checking' | 'valid' | 'invalid' | 'unknown';
type Notify = (message: string, type?: Notice['type']) => void;
const deepSeekBaseUrl = 'https://api.deepseek.com';

const morphSliderItems = [
  { image: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?q=80&w=1600&auto=format&fit=crop', caption: '1' },
  { image: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?q=80&w=1600&auto=format&fit=crop', caption: '2' },
  { image: 'https://images.unsplash.com/photo-1511497584788-876760111969?q=80&w=1600&auto=format&fit=crop', caption: '3' },
  { image: 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?q=80&w=1600&auto=format&fit=crop', caption: '4' },
  { image: 'https://images.unsplash.com/photo-1472214103451-9374bd1c798e?q=80&w=1600&auto=format&fit=crop', caption: '5' },
  { image: 'https://images.unsplash.com/photo-1509316785289-025f5b846b35?q=80&w=1600&auto=format&fit=crop', caption: '6' },
  { image: 'https://images.unsplash.com/photo-1572986350786-002d08b6b87e?q=80&w=1600&auto=format&fit=crop', caption: '7' },
  { image: 'https://images.unsplash.com/photo-1448375240586-882707db888b?q=80&w=1600&auto=format&fit=crop', caption: '8' },
  { image: 'https://images.unsplash.com/photo-1501785888041-af3ef285b470?q=80&w=1600&auto=format&fit=crop', caption: '9' },
];

const morphTransitionOptions: MorphTransition[] = ['melt', 'ripple', 'shear', 'swirl'];
const morphTransitionLabels: Record<MorphTransition, TranslationKey> = {
  melt: 'morphTransitionMelt', ripple: 'morphTransitionRipple', shear: 'morphTransitionShear', swirl: 'morphTransitionSwirl',
};
const morphEaseOptions = ['power1.inOut', 'power2.inOut', 'power3.inOut', 'expo.inOut'] as const;
type MorphEase = typeof morphEaseOptions[number];
const morphEaseLabels: Record<MorphEase, TranslationKey> = {
  'power1.inOut': 'morphEaseGentle',
  'power2.inOut': 'morphEaseSmooth',
  'power3.inOut': 'morphEaseStrong',
  'expo.inOut': 'morphEaseExponential',
};
type MorphPreferences = { transition: MorphTransition; ease: MorphEase };
const morphPreferencesKey = 'codex-console-morph-preferences';
const defaultMorphPreferences: MorphPreferences = { transition: 'melt', ease: 'power2.inOut' };

function loadMorphPreferences(): MorphPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(morphPreferencesKey) ?? 'null') as Partial<MorphPreferences> | null;
    return value && morphTransitionOptions.includes(value.transition as MorphTransition) && morphEaseOptions.includes(value.ease as MorphEase)
      ? value as MorphPreferences : defaultMorphPreferences;
  } catch {
    return defaultMorphPreferences;
  }
}

const creationLoaderBalls = [
  ['#ff6347', 12, 3.4], ['#00ced1', 18, 6.1], ['#adff2f', 10, 2.9], ['#9370db', 16, 7.8],
  ['#ff1493', 14, 4.6], ['#00bfff', 11, 3.3], ['#7fff00', 17, 5.5], ['#dc143c', 13, 6.7],
  ['#8a2be2', 19, 8.2], ['#48d1cc', 15, 9.1], ['#ff4500', 14, 4.2], ['#00ff7f', 16, 5.8],
  ['#ba55d3', 10, 7.3], ['#1e90ff', 18, 6.4], ['#ffa500', 20, 10], ['#ff69b4', 12, 3.7],
  ['#00fa9a', 11, 2.6], ['#9400d3', 17, 6.9], ['#ffb6c1', 13, 5.3], ['#20b2aa', 19, 7.7],
] as const;

const creationGeneratingStageKeys: TranslationKey[] = [
  'creationGeneratingStageConcept',
  'creationGeneratingStageLighting',
  'creationGeneratingStageDetails',
  'creationGeneratingStageRendering',
  'creationGeneratingStageComposition',
  'creationGeneratingStagePalette',
  'creationGeneratingStagePerspective',
  'creationGeneratingStageAtmosphere',
  'creationGeneratingStageMaterials',
  'creationGeneratingStageFocus',
  'creationGeneratingStageDepth',
  'creationGeneratingStageShadows',
  'creationGeneratingStageHighlights',
  'creationGeneratingStageTextures',
  'creationGeneratingStageEdges',
  'creationGeneratingStageBalance',
  'creationGeneratingStageMood',
  'creationGeneratingStagePolishing',
  'creationGeneratingStageChecking',
  'creationGeneratingStageFinishing',
];

export function App() {
  const { t, locale } = useI18n();
  const [page, setPage] = useState<Page>('auth'); const [menuOpen, setMenuOpen] = useState(false); const [notices, setNotices] = useState<Notice[]>([]);
  const [provider, setProvider] = useState<Provider>(() => localStorage.getItem('starbox-provider') === 'deepseek' ? 'deepseek' : 'codex');
  const [creationMounted, setCreationMounted] = useState(false);
  const [selectedAuthFileId, setSelectedAuthFileId] = useState('');
  const [authRefreshVersion, setAuthRefreshVersion] = useState(0);
  const [chatGptLoginLoading, setChatGptLoginLoading] = useState(false);
  const [chatGptLoginCancelling, setChatGptLoginCancelling] = useState(false);
  const chatGptCancelRequested = useRef(false);
  const notify = useCallback<Notify>((message, type = 'success') => { const normalizedMessage = type === 'error' ? message.replace(/[.。]+\s*$/u, '') : message; const id = Date.now() + Math.random(); setNotices((items) => [...items, { id, message: normalizedMessage, type }]); window.setTimeout(() => { setNotices((items) => items.map((item) => item.id === id ? { ...item, closing: true } : item)); window.setTimeout(() => setNotices((items) => items.filter((item) => item.id !== id)), 180); }, 3420); }, []);
  const loginChatGpt = useCallback(async () => {
    chatGptCancelRequested.current = false;
    setChatGptLoginCancelling(false);
    setChatGptLoginLoading(true);
    try {
      const result = await authApi.loginChatGpt();
      setSelectedAuthFileId(result.file.id);
      setAuthRefreshVersion((version) => version + 1);
      setPage('auth');
      notify(t('chatGptLoginSuccess'));
    } catch (error) {
      const cancelledByUser = chatGptCancelRequested.current && error instanceof ApiError && error.code === 'CHATGPT_LOGIN_CANCELLED';
      if (!cancelledByUser) notify(apiError(error, t), 'error');
    } finally {
      setChatGptLoginLoading(false);
      setChatGptLoginCancelling(false);
      chatGptCancelRequested.current = false;
    }
  }, [notify, t]);
  const cancelChatGptLogin = useCallback(async () => {
    if (!chatGptLoginLoading || chatGptLoginCancelling) return;
    chatGptCancelRequested.current = true;
    setChatGptLoginCancelling(true);
    try {
      await authApi.cancelChatGptLogin();
    } catch (error) {
      chatGptCancelRequested.current = false;
      setChatGptLoginCancelling(false);
      notify(apiError(error, t), 'error');
    }
  }, [chatGptLoginCancelling, chatGptLoginLoading, notify, t]);
  const navigate = useCallback((nextPage: Page) => {
    if (nextPage === 'create') setCreationMounted(true);
    setPage(nextPage);
  }, []);
  const selectProvider = useCallback((nextProvider: Provider) => {
    localStorage.setItem('starbox-provider', nextProvider);
    setProvider(nextProvider);
    setPage('auth');
  }, []);
  useEffect(() => { document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'; }, [locale]);
  const navigation: Array<{ id: Page; label: string; icon: typeof Gauge }> = [{ id: 'home', label: t('dashboard'), icon: Gauge }, { id: 'auth', label: t('authFiles'), icon: FileKey2 }, { id: 'create', label: t('creationMenu'), icon: Sparkles }, { id: 'monitor', label: t('monitoring'), icon: Monitor }, { id: 'models', label: t('modelsConfig'), icon: Sparkles }, { id: 'logs', label: t('requestLogs'), icon: List }];
  const title = navigation.find((item) => item.id === page)?.label ?? t('dashboard');
  const view = page === 'home' ? <HomeView notify={notify} onNavigate={setPage} /> : page === 'auth' ? <AuthView notify={notify} onOpenMonitoring={() => setPage('monitor')} /> : page === 'monitor' ? <MonitorView notify={notify} /> : page === 'models' ? <ModelsView notify={notify} /> : <LogsView notify={notify} />;
  return <div className="pulse-stage"><DesktopTitlebar />{page === 'auth' ? <AccountsPreview key={authRefreshVersion} provider={provider} notify={notify} selectedId={selectedAuthFileId} onSelect={setSelectedAuthFileId} /> : page === 'logs' ? <LogsPreview notify={notify} /> : null}{creationMounted ? <div hidden={page !== 'create'}><CreationView selectedAuthFileId={selectedAuthFileId} onSelectAuthFile={setSelectedAuthFileId} notify={notify} /></div> : null}<BottomNav page={page} provider={provider} onProviderChange={selectProvider} onNavigate={navigate} onLoginChatGpt={() => void loginChatGpt()} loginLoading={chatGptLoginLoading} t={t} /><MotionPresence>{chatGptLoginLoading ? <ChatGptLoginOverlay cancelling={chatGptLoginCancelling} onCancel={() => void cancelChatGptLogin()} /> : null}</MotionPresence><div className="notice-stack" role="status" aria-live="polite">{notices.map((notice) => <div className={`notice ${notice.type}${notice.closing ? ' closing' : ''}`} key={notice.id}>{notice.type === 'success' ? <CheckCircle2 size={16} /> : <X size={16} />}<span>{notice.message}</span></div>)}</div></div>;
}

function OpenAiMark() { return <svg className="openai-mark" viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden="true"><title>OpenAI (ChatGPT)</title><path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" /></svg>; }

function DeepSeekMark({ className = 'deepseek-mark' }: { className?: string }) { return <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path fill="#4D6BFE" d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 0 1-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 0 0-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 0 1-.465.137 9.597 9.597 0 0 0-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 0 0 1.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 0 1 1.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 0 1 .415-.287.302.302 0 0 1 .2.288.306.306 0 0 1-.31.307.303.303 0 0 1-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 0 1-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 0 1 .016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 0 1-.254-.078.253.253 0 0 1-.114-.358c.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z" /></svg>; }

function GitHubMark({ size = 34 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path fillRule="evenodd" clipRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.3 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z" transform="scale(64)" fill="currentColor" />
  </svg>;
}

function ColorKeyMark() { return <svg className="color-key-mark" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="#4D6BFE" d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 0 1-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 0 0-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 0 1-.465.137 9.597 9.597 0 0 0-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 0 0 1.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 0 1 1.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 0 1 .415-.287.302.302 0 0 1 .2.288.306.306 0 0 1-.31.307.303.303 0 0 1-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 0 1-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 0 1 .016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 0 1-.254-.078.253.253 0 0 1-.114-.358c.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z" /></svg>; }

function HeartbeatIcon({ size = 21 }: { size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 3h16a1 1 0 0 1 1 1v4M20 20H4a1 1 0 0 1-1-1v-4M3 8V4a1 1 0 0 1 1-1M21 16v4a1 1 0 0 1-1 1" /><path d="M3 11h4l2.2 4.2L13 7l2.4 4H21" /></svg>; }
function ColorMailMark() { return <svg className="color-mail-mark" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid" viewBox="0 0 256 260" aria-hidden="true"><path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z" /></svg>; }
type NavIcon = (props: { size?: number }) => ReactNode;
function BottomNav({ page, provider, onProviderChange, onNavigate, onLoginChatGpt, loginLoading, t }: {
  page: Page;
  provider: Provider;
  onProviderChange: (provider: Provider) => void;
  onNavigate: (page: Page) => void;
  onLoginChatGpt: () => void;
  loginLoading: boolean;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const providerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!providerMenuOpen) return undefined;
    const close = (event: PointerEvent) => {
      if (!providerRef.current?.contains(event.target as Node)) setProviderMenuOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [providerMenuOpen]);
  const items: Array<{ id: Page; label: TranslationKey; icon: NavIcon }> = [
    { id: 'auth', label: 'pulseAccount', icon: UserRound }, { id: 'create', label: 'creationMenu', icon: CreationIcon }, { id: 'logs', label: 'pulseLogs', icon: HeartbeatIcon },
  ];
  const chooseProvider = (nextProvider: Provider) => {
    onProviderChange(nextProvider);
    setProviderMenuOpen(false);
  };
  return <nav className="pulse-bottom-nav" aria-label={t('menu')}>
    <div className="pulse-brand" ref={providerRef}>
      <button className="pulse-provider-trigger" type="button" aria-label={t('provider')} aria-expanded={providerMenuOpen} onClick={() => setProviderMenuOpen((open) => !open)}>{provider === 'deepseek' ? <DeepSeekMark /> : <OpenAiMark />}</button>
      {provider === 'codex' ? <button className="pulse-provider-action" type="button" title={t('chatGptLogin')} disabled={loginLoading} onClick={onLoginChatGpt}><strong>ChatGPT</strong>{loginLoading ? <SolnSpin label={t('chatGptLoggingIn')} /> : null}</button> : <strong>DeepSeek</strong>}
      <MotionPresence>{providerMenuOpen ? <div className="account-dropdown-menu pulse-provider-menu">
        <button className={provider === 'codex' ? 'selected' : ''} type="button" onClick={() => chooseProvider('codex')}><OpenAiMark /><span>{t('codexProvider')}</span></button>
        <button className={provider === 'deepseek' ? 'selected' : ''} type="button" onClick={() => chooseProvider('deepseek')}><DeepSeekMark /><span>{t('deepSeekProvider')}</span></button>
      </div> : null}</MotionPresence>
    </div>
    <div className="pulse-nav-links">{items.map(({ id, label, icon: Icon }) => <button key={id} className={page === id ? 'active' : ''} onClick={() => onNavigate(id)}><Icon size={21} /><span>{t(label)}</span></button>)}</div>
    <a className="pulse-github-link" href="https://github.com/solnsu/StarBox_AITools" target="_blank" rel="noreferrer" aria-label="GitHub" title="GitHub"><GitHubMark /></a>
  </nav>;
}

function ChatGptLoginOverlay({ cancelling, onCancel }: { cancelling: boolean; onCancel: () => void }) {
  const { t } = useI18n();
  return <div className="chatgpt-login-layer" role="dialog" aria-modal="true" aria-labelledby="chatgpt-login-title">
    <section className="chatgpt-login-card">
      <OpenAiMark />
      <h2 id="chatgpt-login-title">{t('chatGptLoggingIn')}</h2>
      <button type="button" disabled={cancelling} onClick={onCancel}>{cancelling ? t('chatGptCancelling') : t('cancel')}</button>
    </section>
  </div>;
}

function CreationIcon({ size = 21 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.05" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4.25 21.25c1.2-7.08 2.45-11.3 5.45-14.3 2.55-2.55 5.65-3.2 10.05-3.2-1.15 3.86-2.5 6.74-5.25 9.35-2.75 2.6-5.7 3.45-10.25 4.1" />
    <path d="M14.1 10.85 18 14.75" />
    <path d="M6.35 4.15v4.2M4.25 6.25h4.2" />
  </svg>;
}

function CollapseCornersIcon({ size = 19 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 4l6 6M10 6v4H6M20 4l-6 6M14 6v4h4M4 20l6-6M6 14h4v4M20 20l-6-6M18 14h-4v4" />
  </svg>;
}

function AccountModelSkeleton({ label }: { label: string }) {
  return <div className="account-model-skeleton" role="status" aria-label={label}>
    {Array.from({ length: 5 }, (_, index) => <div className="account-model-skeleton-row" aria-hidden="true" key={index}>
      <span className="account-model-skeleton-icon" />
      <span className="account-model-skeleton-name" style={{ width: `${58 + (index % 3) * 9}%` }} />
      <span className="account-model-skeleton-action" />
    </div>)}
  </div>;
}

const deepSeekBalanceMetrics = [
  { key: 'totalBalance', label: 'totalBalance' },
  { key: 'grantedBalance', label: 'grantedBalance' },
  { key: 'toppedUpBalance', label: 'toppedUpBalance' },
] as const satisfies ReadonlyArray<{ key: 'totalBalance' | 'grantedBalance' | 'toppedUpBalance'; label: TranslationKey }>;

function formatDeepSeekBalanceAmount(amount: string, locale: string) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return amount;
  return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  }).format(value);
}

function DeepSeekBalanceCard({ balance, loading }: { balance: DeepSeekBalance | null; loading: boolean }) {
  const { t, locale } = useI18n();
  const groups = balance ? [...balance.balanceInfos]
    .filter((info) => info.currency === 'CNY' || info.currency === 'USD')
    .sort((left, right) => left.currency === 'CNY' ? -1 : right.currency === 'CNY' ? 1 : 0)
    .slice(0, 2) : [];
  return <section className="account-panel-card account-quota-card deepseek-balance-card">
    <h3>{t('balanceOverview')}</h3>
    {loading && !balance ? <div className="deepseek-balance-loading"><SolnSpin label={t('loading')} /></div> : groups.length ? <div className="deepseek-balance-content">
      <div className="deepseek-balance-chart" aria-hidden="true">
        <span className="deepseek-balance-chart-line" />
        {groups.map((info) => {
          const maximum = Math.max(...deepSeekBalanceMetrics.map(({ key }) => Math.abs(Number(info[key])) || 0), 1);
          return <div className={`deepseek-balance-bar-group ${info.currency.toLowerCase()}`} key={info.currency}>
            <div className="deepseek-balance-bars">
              {deepSeekBalanceMetrics.map(({ key }) => {
                const value = Number(info[key]);
                const height = Math.max(28, (Math.abs(value) / maximum) * 100);
                return <span className="deepseek-balance-bar-slot" key={key}>
                  <i className={`deepseek-balance-bar${value < 0 ? ' negative' : ''}`} style={{ height: `${height}%` }}><b /></i>
                </span>;
              })}
            </div>
          </div>;
        })}
      </div>
      <div className="deepseek-balance-readings cp-sidebar-scrollbar">
        {groups.map((info) => <section className={`deepseek-balance-reading-group ${info.currency.toLowerCase()}`} key={info.currency}>
          <header><i /><strong>{info.currency === 'CNY' ? t('deepSeekBalanceCurrencyCny') : info.currency === 'USD' ? t('deepSeekBalanceCurrencyUsd') : info.currency}</strong></header>
          {deepSeekBalanceMetrics.map(({ key, label }) => <div className="deepseek-balance-reading" key={key}>
            <span>{t(label)}</span>
            <strong title={formatDeepSeekBalanceAmount(info[key], locale)}>{formatDeepSeekBalanceAmount(info[key], locale)}</strong>
          </div>)}
        </section>)}
      </div>
    </div> : <div className="account-model-state">{t('noBalanceInformation')}</div>}
  </section>;
}

function DeepSeekAccountInfoCard({ apiKey, status, locale }: {
  apiKey: DeepSeekApiKey | null;
  status: DeepSeekCredentialStatus;
  locale: string;
}) {
  const { t } = useI18n();
  return <section className="account-panel-card account-info-card">
    <header><h3>{t('accountInfo')}</h3>{status === 'valid' || status === 'invalid' ? <span className={`account-info-status ${status === 'valid' ? 'normal' : 'expired'}`}><i />{status === 'valid' ? t('credentialValid') : t('credentialInvalid')}</span> : null}</header>
    {apiKey ? <div className="account-info-list cp-sidebar-scrollbar">
      <div className="account-info-row"><span className="account-info-icon"><KeyRound size={16} /></span><span><small>{t('deepSeekApiKey')}</small><strong>{apiKey.maskedKey}</strong></span></div>
      <div className="account-info-row"><span className="account-info-icon"><ReceiptText size={16} /></span><span><small>{t('deepSeekBillingCurrency')}</small><strong>{apiKey.billingCurrency === 'CNY' ? t('deepSeekCurrencyCny') : t('deepSeekCurrencyUsd')}</strong></span></div>
      <div className="account-info-row"><span className="account-info-icon"><Clock3 size={16} /></span><span><small>{t('addedAt')}</small><strong>{formatDate(apiKey.createdAt, locale)}</strong></span></div>
    </div> : <div className="account-info-state">{t('noInformation')}</div>}
  </section>;
}

function CreationGeneratingPlaceholder({ label }: { label: string }) {
  const { t } = useI18n();
  return <div className="creation-generating-placeholder" role="status" aria-label={label}>
    <aside className="container-loader" aria-hidden="true">
      {creationLoaderBalls.map(([color, size, duration], index) => <article className="ball" key={`${color}-${index}`} style={{ '--color': color, '--i': `${size}px`, '--d': `${duration}s` } as CSSProperties} />)}
      <div className="creation-generating-stages">
        {creationGeneratingStageKeys.map((key, index) => <span key={key} style={{ '--stage-index': index } as CSSProperties}>{t(key)}</span>)}
      </div>
    </aside>
  </div>;
}

type CreationDraft = { text: string; model: string; size?: ImageSize; quality?: ImageQuality; attachments?: Array<{ name: string; url: string; dataUrl?: string }> };
type CreationMessage = Omit<CreationMessageData, 'retryDraft'> & { retryDraft?: CreationDraft };
type CreationSession = Omit<CreationSessionData, 'messages'> & { messages: CreationMessage[] };
type CreatedImage = CreationImageData;
type CreationGenerationContext = {
  session: Pick<CreationSession, 'id' | 'title' | 'createdAt'>;
  userMessage: CreationMessage;
};

function CreationMessageItem({ message, availableImageUrls, onRetry, onSelectImage, onCopy }: { message: CreationMessage; availableImageUrls: ReadonlySet<string>; onRetry: (draft: CreationDraft) => void; onSelectImage: (url: string) => void; onCopy: (message: CreationMessage) => Promise<boolean> }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await onCopy(message)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }
  };
  const copyAction = <button className={`creation-message-copy${copied ? ' copied' : ''}`} type="button" onClick={() => void copy()} aria-label={t('creationCopy')} title={copied ? t('creationCopied') : t('creationCopy')}><Copy size={14} /></button>;
  if (message.kind === 'error') return <div className="creation-message-row assistant error">
    <div className="creation-error-message"><span>{message.text}</span></div>
    <div className="creation-error-actions">
      {message.retryDraft && <button type="button" onClick={() => onRetry(message.retryDraft!)} aria-label={t('creationRetry')} title={t('creationRetry')}><RefreshCw /></button>}
    </div>
  </div>;
  if (message.role === 'assistant' && message.attachments?.length) return <div className="creation-message-row assistant generated">
    <div className="creation-message-generated"><div className="creation-message-generated-images">{message.attachments.map((attachment) => availableImageUrls.has(attachment.url)
      ? <button type="button" key={attachment.url} onClick={() => onSelectImage(attachment.url)} aria-label={attachment.name}><img src={attachment.url} alt={attachment.name} /></button>
      : <div className="creation-error-message" key={attachment.url}><span>{t('creationImageMissing')}</span></div>)}</div>{message.attachments.some((attachment) => availableImageUrls.has(attachment.url)) ? <div className="creation-message-actions">{copyAction}</div> : null}</div>
  </div>;
  return <div className={`creation-message-row ${message.role}`}><div className="creation-message-content"><div className="creation-message-primary">{message.attachments?.length ? <div className={`creation-message-images${message.attachments.length === 1 ? ' single' : ''}`}>{message.attachments.map((attachment) => <img src={attachment.url} alt={attachment.name} key={attachment.url} />)}</div> : null}{message.text && <div className="creation-message-bubble"><span>{message.text}</span></div>}</div><div className="creation-message-actions">{copyAction}</div></div></div>;
}

function MorphSettingsDropdown({ value, onChange }: { value: MorphPreferences; onChange: (value: MorphPreferences) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);
  return <div className="creation-morph-settings" ref={rootRef}>
    <button className="creation-morph-settings-trigger" type="button" aria-label={t('morphSliderSettings')} title={t('morphSliderSettings')} aria-expanded={open} onClick={() => setOpen((current) => !current)}><SlidersHorizontal size={18} /></button>
    <MotionPresence>{open ? <div className="creation-morph-settings-menu">
      <header><strong>{t('morphSliderSettings')}</strong></header>
      <div className="creation-morph-field"><span>{t('morphTransition')}</span><CustomSelect value={value.transition} ariaLabel={t('morphTransition')} tone="dark" menuPlacement="top" options={morphTransitionOptions.map((transition) => ({ value: transition, label: t(morphTransitionLabels[transition]) }))} onChange={(transition) => onChange({ ...value, transition: transition as MorphTransition })} /></div>
      <div className="creation-morph-field"><span>{t('morphEase')}</span><CustomSelect value={value.ease} ariaLabel={t('morphEase')} tone="dark" menuPlacement="top" options={morphEaseOptions.map((ease) => ({ value: ease, label: t(morphEaseLabels[ease]) }))} onChange={(ease) => onChange({ ...value, ease: ease as MorphEase })} /></div>
    </div> : null}</MotionPresence>
  </div>;
}

function CreationView({ selectedAuthFileId, onSelectAuthFile, notify }: {
  selectedAuthFileId: string;
  onSelectAuthFile: (id: string) => void;
  notify: Notify;
}) {
  const { t, locale } = useI18n();
  const createSession = (): CreationSession => {
    const now = Date.now();
    return { id: crypto.randomUUID(), title: t('creationUntitledSession'), createdAt: now, updatedAt: now, messages: [] };
  };
  const [sessions, setSessions] = useState<CreationSession[]>(() => [createSession()]);
  const [activeSessionId, setActiveSessionId] = useState(() => sessions[0]!.id);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [pendingDeleteSession, setPendingDeleteSession] = useState<CreationSession | null>(null);
  const [morphGalleryOpen, setMorphGalleryOpen] = useState(false);
  const [morphStartIndex, setMorphStartIndex] = useState(0);
  const [morphPreferences, setMorphPreferences] = useState<MorphPreferences>(loadMorphPreferences);
  const [generating, setGenerating] = useState<{ sessionId: string; draft: CreationDraft } | null>(null);
  const [imageModels, setImageModels] = useState<Array<{ id: string; label: string }>>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [imageSize, setImageSize] = useState<ImageSize>('auto');
  const [imageQuality, setImageQuality] = useState<ImageQuality>('auto');
  const [createdImages, setCreatedImages] = useState<CreatedImage[]>([]);
  const [files, setFiles] = useState<AuthFile[]>([]);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountSelectorRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const pinnedToBottomRef = useRef(true);
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0]!;
  const selectedAuthFile = files.find((file) => file.id === selectedAuthFileId) ?? files[0] ?? null;
  const hasCodexCredential = files.some((file) => !file.disabled);
  const displayedAccount = selectedAuthFile?.email ?? selectedAuthFile?.fileName ?? t('noAccountGreeting');
  const availableImageUrls = useMemo(() => new Set(createdImages.map((image) => image.url)), [createdImages]);
  const rightItems = useMemo(() => createdImages.length
    ? createdImages.map((image, index) => ({ image: image.url, caption: String(index + 1) }))
    : morphSliderItems, [createdImages]);
  useEffect(() => {
    setMorphStartIndex((current) => Math.min(current, Math.max(0, rightItems.length - 1)));
  }, [rightItems.length]);
  const updateScrollState = useCallback(() => {
    const element = messagesRef.current;
    if (!element) return;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    const atBottom = distanceFromBottom <= 24;
    pinnedToBottomRef.current = atBottom;
    setShowScrollToBottom(!atBottom && element.scrollHeight > element.clientHeight + 8);
  }, []);
  const scrollToBottom = useCallback(() => {
    const element = messagesRef.current;
    if (!element) return;
    pinnedToBottomRef.current = true;
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    window.setTimeout(updateScrollState, 420);
  }, [updateScrollState]);
  useEffect(() => {
    const element = messagesRef.current;
    if (!element) return undefined;
    element.addEventListener('scroll', updateScrollState, { passive: true });
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(element);
    updateScrollState();
    return () => {
      element.removeEventListener('scroll', updateScrollState);
      observer.disconnect();
    };
  }, [updateScrollState]);
  useEffect(() => {
    pinnedToBottomRef.current = true;
  }, [activeSessionId]);
  useEffect(() => {
    let active = true;
    const loadAccounts = async () => {
      try {
        const authResult = await authApi.list();
        if (!active) return;
        setFiles(authResult.files);
      } catch (error) {
        if (active) notify(apiError(error, t), 'error');
      }
    };
    void loadAccounts();
    window.addEventListener('focus', loadAccounts);
    return () => {
      active = false;
      window.removeEventListener('focus', loadAccounts);
    };
  }, [notify, t]);
  useEffect(() => {
    if (!accountMenuOpen) return undefined;
    const close = (event: PointerEvent) => {
      if (!accountSelectorRef.current?.contains(event.target as Node)) setAccountMenuOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [accountMenuOpen]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const element = messagesRef.current;
      if (!element) return;
      if (pinnedToBottomRef.current) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
      updateScrollState();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSessionId, activeSession.messages.length, generating?.sessionId, workspaceLoading, updateScrollState]);
  useEffect(() => {
    let active = true;
    setWorkspaceLoading(true);
    const load = async () => {
      try {
        const workspace = await creationApi.workspace();
        let restored = workspace.sessions as CreationSession[];
        if (!restored.length) {
          const session = createSession();
          await creationApi.createSession(session);
          restored = [session];
        }
        if (!active) return;
        setSessions(restored);
        setActiveSessionId((current) => restored.some((session) => session.id === current) ? current : restored[0]!.id);
        setCreatedImages(workspace.images);
      } catch (error) {
        if (active) notify(apiError(error, t), 'error');
      } finally {
        if (active) setWorkspaceLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [notify, t]);
  useEffect(() => {
    const syncImages = () => {
      void creationApi.workspace().then((workspace) => setCreatedImages(workspace.images)).catch((error) => notify(apiError(error, t), 'error'));
    };
    window.addEventListener('focus', syncImages);
    return () => window.removeEventListener('focus', syncImages);
  }, [notify, t]);
  useEffect(() => {
    if (!hasCodexCredential) { setImageModels([]); setModelsLoading(false); return; }
    let active = true;
    setModelsLoading(true);
    modelsApi.list().then((result) => {
      if (active) setImageModels(result.models
        .filter((model) => model.id.startsWith('gpt-image-'))
        .map((model) => ({ id: model.id, label: model.displayName }))
        .sort((left, right) => Number(right.id === 'gpt-image-2') - Number(left.id === 'gpt-image-2')));
    }).catch((error) => {
      if (active) { setImageModels([]); notify(apiError(error, t), 'error'); }
    }).finally(() => { if (active) setModelsLoading(false); });
    return () => { active = false; };
  }, [hasCodexCredential, notify, t]);
  const newSession = async () => {
    if (creatingSession) return;
    const session = createSession();
    setCreatingSession(true);
    try {
      await creationApi.createSession(session);
      setSessions((current) => [session, ...current]);
      setActiveSessionId(session.id);
      setHistoryOpen(false);
    } catch (error) { notify(apiError(error, t), 'error'); }
    finally { setCreatingSession(false); }
  };
  const requestDeleteSession = (sessionId: string) => {
    if (deletingSessionId || generating?.sessionId === sessionId) return;
    const session = sessions.find((item) => item.id === sessionId);
    if (session) setPendingDeleteSession(session);
  };
  const deleteSession = async (sessionId: string) => {
    if (deletingSessionId || generating?.sessionId === sessionId) return;
    setPendingDeleteSession(null);
    setDeletingSessionId(sessionId);
    try {
      await creationApi.deleteSession(sessionId);
      const deletedIndex = sessions.findIndex((session) => session.id === sessionId);
      const remaining = sessions.filter((session) => session.id !== sessionId);
      if (remaining.length) {
        const fallback = remaining[Math.min(Math.max(deletedIndex, 0), remaining.length - 1)]!;
        setSessions(remaining);
        setActiveSessionId((current) => current === sessionId ? fallback.id : current);
      } else {
        const replacement = createSession();
        await creationApi.createSession(replacement);
        setSessions([replacement]);
        setActiveSessionId(replacement.id);
      }
      setHistoryOpen(false);
      notify(t('creationSessionDeleted'));
    } catch (error) {
      notify(apiError(error, t), 'error');
    } finally {
      setDeletingSessionId(null);
    }
  };
  const openImagesDirectory = async () => { try { await creationApi.openImagesDirectory(); notify(t('creationFolderOpened')); } catch (error) { notify(apiError(error, t), 'error'); } };
  const appendStoredMessage = (sessionId: string, message: CreationMessage) => {
    setSessions((current) => current.map((session) => session.id === sessionId ? {
      ...session,
      updatedAt: message.createdAt,
      messages: [...session.messages, message],
    } : session));
  };
  const persistMessage = (sessionId: string, message: CreationMessage) => {
    const inputAttachments = message.attachments?.flatMap((attachment) => attachment.dataUrl
      ? [{ name: attachment.name, dataUrl: attachment.dataUrl }] : []);
    const attachments = message.attachments?.filter((attachment) => attachment.url.startsWith('/api/generated-images/'));
    const payload: CreationMessageData = {
      id: message.id,
      role: message.role,
      text: message.text,
      ...(message.kind ? { kind: message.kind } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...(inputAttachments?.length ? { inputAttachments } : {}),
      ...(message.retryDraft ? { retryDraft: { text: message.retryDraft.text, model: message.retryDraft.model, size: message.retryDraft.size, quality: message.retryDraft.quality, inputImages: message.retryDraft.attachments?.flatMap((attachment) => attachment.dataUrl ? [attachment.dataUrl] : []) } } : {}),
      createdAt: message.createdAt,
    };
    void creationApi.addMessage(sessionId, payload).catch((error) => notify(apiError(error, t), 'error'));
  };
  const appendToSession = (sessionId: string, input: Omit<CreationMessage, 'id' | 'createdAt'>) => {
    const message: CreationMessage = { ...input, id: crypto.randomUUID(), createdAt: Date.now() };
    appendStoredMessage(sessionId, message);
    persistMessage(sessionId, message);
  };
  const runGeneration = async (sessionId: string, draft: CreationDraft, generationContext?: CreationGenerationContext) => {
    if (!hasCodexCredential) {
      if (generationContext) persistMessage(sessionId, generationContext.userMessage);
      appendToSession(sessionId, { role: 'assistant', text: t('errorNoCredential'), kind: 'error', retryDraft: draft });
      return;
    }
    setGenerating({ sessionId, draft });
    try {
      const currentSession = sessions.find((session) => session.id === sessionId);
      const session = generationContext?.session ?? (currentSession && {
        id: currentSession.id, title: currentSession.title, createdAt: currentSession.createdAt,
      });
      if (!session) throw new ApiError('CREATION_SESSION_NOT_FOUND');
      const result = await creationApi.generate({
        sessionId,
        session,
        ...(generationContext ? { userMessage: {
          id: generationContext.userMessage.id,
          role: 'user' as const,
          text: generationContext.userMessage.text,
          ...(generationContext.userMessage.attachments?.length ? {
            attachments: generationContext.userMessage.attachments.flatMap((attachment) => attachment.dataUrl
              ? [{ name: attachment.name, dataUrl: attachment.dataUrl }] : []),
          } : {}),
          createdAt: generationContext.userMessage.createdAt,
        } } : {}),
        model: draft.model,
        prompt: draft.text,
        size: draft.size ?? 'auto',
        quality: draft.quality ?? 'auto',
        inputImages: draft.attachments?.flatMap((attachment) => attachment.dataUrl ? [attachment.dataUrl] : []),
      });
      appendStoredMessage(sessionId, result.message as CreationMessage);
      if (result.data.length) {
        setCreatedImages((current) => [...result.data, ...current].sort((left, right) => right.createdAt - left.createdAt));
        setMorphStartIndex(0);
        setMorphGalleryOpen(false);
      }
    } catch (error) {
      const detail = error instanceof ApiError && error.detail ? error.detail : apiError(error, t);
      appendToSession(sessionId, { role: 'assistant', text: detail, kind: 'error', retryDraft: draft });
    } finally {
      setGenerating((current) => current?.sessionId === sessionId ? null : current);
    }
  };
  const appendMessage = (message: CreationDraft) => {
    const sessionId = activeSessionId;
    const currentSession = sessions.find((session) => session.id === sessionId);
    const title = currentSession?.messages.some((item) => item.role === 'user')
      ? currentSession.title : (message.text.slice(0, 24) || t('creationImageSession'));
    const userMessage: CreationMessage = {
      id: crypto.randomUUID(), role: 'user', text: message.text,
      attachments: message.attachments, createdAt: Date.now(),
    };
    setSessions((current) => current.map((session) => session.id === sessionId ? {
      ...session,
      title,
      updatedAt: userMessage.createdAt,
      messages: [...session.messages, userMessage],
    } : session));
    void runGeneration(sessionId, message, {
      session: {
        id: sessionId,
        title,
        createdAt: currentSession?.createdAt ?? userMessage.createdAt,
      },
      userMessage,
    });
  };
  const selectCreatedImage = (url: string) => {
    const index = createdImages.findIndex((image) => image.url === url);
    if (index < 0) return;
    setMorphStartIndex(index);
    setMorphGalleryOpen(false);
  };
  const copyImage = async (url: string) => {
    const imageResponse = await fetch(url);
    if (!imageResponse.ok) throw new Error('IMAGE_COPY_FAILED');
    const blob = await imageResponse.blob();
    if (navigator.clipboard && typeof ClipboardItem !== 'undefined' && blob.type.startsWith('image/')) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        return;
      } catch { /* fall back to the image URL for unsupported clipboard formats */ }
    }
    await navigator.clipboard.writeText(url);
  };
  const copyCreationMessage = async (message: CreationMessage) => {
    try {
      const attachment = message.role === 'assistant'
        ? message.attachments?.find((item) => availableImageUrls.has(item.url))
        : message.attachments?.[0];
      if (attachment) {
        await copyImage(attachment.url);
      } else if (message.text) {
        await navigator.clipboard.writeText(message.text);
      } else {
        return false;
      }
      notify(t('creationCopied'));
      return true;
    } catch {
      notify(t('creationCopyFailed'), 'error');
      return false;
    }
  };
  const copyCurrentImage = async () => {
    const image = rightItems[morphStartIndex] ?? rightItems[0];
    if (!image) return;
    try {
      await copyImage(image.image);
      notify(t('creationCopied'));
    } catch {
      notify(t('creationCopyFailed'), 'error');
    }
  };
  const saveMorphPreferences = (preferences: MorphPreferences) => {
    localStorage.setItem(morphPreferencesKey, JSON.stringify(preferences));
    setMorphPreferences(preferences);
  };
  return <main className="creation-canvas">
    <section className="creation-card creation-chat-card">
      <header className="creation-chat-header"><button className="creation-header-button" type="button" onClick={() => setHistoryOpen(true)} aria-label={t('creationOpenSessions')} title={t('creationOpenSessions')}><Menu size={21} /></button><div className="creation-account-display" ref={accountSelectorRef}><strong title={displayedAccount}>{displayedAccount}</strong>{files.length ? <div className="account-dropdown"><button className="account-dropdown-trigger" type="button" aria-label={t('switchAccount')} aria-expanded={accountMenuOpen} onClick={() => setAccountMenuOpen((open) => !open)}><ChevronDown size={16} /></button><MotionPresence>{accountMenuOpen ? <div className="account-dropdown-menu cp-sidebar-scrollbar">{files.map((file) => <button className={file.id === selectedAuthFile?.id ? 'selected' : ''} type="button" key={file.id} onClick={() => { onSelectAuthFile(file.id); setAccountMenuOpen(false); }}><span>{file.email ?? file.fileName}</span></button>)}</div> : null}</MotionPresence></div> : null}</div><button className="creation-header-button" type="button" onClick={() => void openImagesDirectory()} aria-label={t('creationOpenFolder')} title={t('creationOpenFolder')}><FolderOpen size={20} /></button></header>
      <div className="creation-chat-messages-wrap"><div ref={messagesRef} className="creation-chat-messages cp-sidebar-scrollbar">{workspaceLoading ? <div className="loading"><SolnSpin label={t('loading')} />{t('loading')}</div> : activeSession.messages.map((message) => <CreationMessageItem message={message} availableImageUrls={availableImageUrls} key={message.id} onRetry={(draft) => void runGeneration(activeSessionId, draft)} onSelectImage={selectCreatedImage} onCopy={copyCreationMessage} />)}{generating?.sessionId === activeSessionId && <CreationGeneratingPlaceholder label={t('creationGenerating')} />}</div>{showScrollToBottom && <button className="creation-scroll-to-bottom" type="button" onClick={scrollToBottom} aria-label={t('creationScrollToBottom')} title={t('creationScrollToBottom')}><ChevronDown size={18} /></button>}</div>
      <div className="creation-composer"><AssistantComposer key={activeSessionId} addAttachmentLabel={t('creationAttach')} disabled={workspaceLoading || Boolean(generating)} loadingLabel={t('loading')} models={imageModels} modelsLoading={modelsLoading} modelLabel={t('creationModelLabel')} modelIcon={<OpenAiMark />} sizeLabel={t('creationImageSize')} qualityLabel={t('creationImageQuality')} sizeOptions={[{ value: 'auto', label: `${t('creationImageSize')} ${t('creationSizeAuto')}` }, { value: '1024x1024', label: t('creationSizeSquare') }, { value: '1536x1024', label: t('creationSizeLandscape') }, { value: '1024x1536', label: t('creationSizePortrait') }]} qualityOptions={[{ value: 'auto', label: `${t('creationImageQuality')} ${t('creationQualityAuto')}` }, { value: 'low', label: t('creationQualityLow') }, { value: 'medium', label: t('creationQualityMedium') }, { value: 'high', label: t('creationQualityHigh') }]} imageSize={imageSize} imageQuality={imageQuality} onImageSizeChange={setImageSize} onImageQualityChange={setImageQuality} placeholder={t('creationChatPlaceholder')} removeAttachmentLabel={t('creationRemoveAttachment')} sendLabel={t('creationChatSend')} onInvalidAttachments={(reason) => notify(t(reason === 'limit' ? 'creationAttachmentLimit' : 'creationAttachmentInvalid'), 'error')} onSend={appendMessage} /></div>
      <MotionPresence>{historyOpen ? <div className="creation-history-layer"><button className="creation-history-backdrop" type="button" onClick={() => setHistoryOpen(false)} aria-label={t('close')} /><aside className="creation-history-panel"><header><h2>{t('creationSessionsTitle')}</h2><button type="button" onClick={() => setHistoryOpen(false)} aria-label={t('close')}><X size={19} /></button></header><button className="creation-new-session" type="button" onClick={() => void newSession()} disabled={creatingSession}><Plus size={17} />{creatingSession ? t('loading') : t('creationNewSession')}</button><div className="creation-session-list cp-sidebar-scrollbar">{sessions.map((session) => <div className={`creation-session-item${session.id === activeSessionId ? ' active' : ''}`} key={session.id}><button className="creation-session-select" type="button" title={session.title} onClick={() => { setActiveSessionId(session.id); setHistoryOpen(false); }}><MessageCircle size={16} /><span><strong>{session.title}</strong><small>{formatDate(session.createdAt, locale)}</small></span></button><button className="creation-session-delete" type="button" onClick={() => requestDeleteSession(session.id)} disabled={deletingSessionId === session.id || generating?.sessionId === session.id} aria-label={t('creationDeleteSession')} title={t('creationDeleteSession')}><Trash2 size={15} /></button></div>)}</div></aside></div> : null}</MotionPresence>
      <MotionPresence>{pendingDeleteSession ? <Dialog title={t('creationDeleteSessionTitle')} onClose={() => setPendingDeleteSession(null)}><p>{t('creationDeleteSessionBody')}</p><div className="dialog-actions"><Button variant="secondary" onClick={() => setPendingDeleteSession(null)}>{t('cancel')}</Button><Button variant="danger" disabled={Boolean(deletingSessionId)} onClick={() => void deleteSession(pendingDeleteSession.id)}>{deletingSessionId ? <Spinner /> : <Trash2 size={15} />}{t('confirmDelete')}</Button></div></Dialog> : null}</MotionPresence>
    </section>
    <section className={`creation-card creation-morph-card${morphGalleryOpen ? ' is-gallery' : ''}`} aria-label={t('morphSliderTitle')}>
      <div className={`creation-morph-stage${morphGalleryOpen ? '' : ' is-active'}`} aria-hidden={morphGalleryOpen} inert={morphGalleryOpen ? true : undefined}>
        <MorphSlider startIndex={morphStartIndex} onIndexChange={setMorphStartIndex} items={rightItems} imageFit={createdImages.length ? 'contain' : 'cover'} transition={morphPreferences.transition} intensity={0.55} aberration={0.35} drift={0.4} autoplay={false} overlayColor="#ffffff" duration={1.1} ease={morphPreferences.ease} scale={2.4} autoplayDelay={4} loop radius={16} showCaptions showControls showIndicators />
        <button className="creation-morph-copy-button" type="button" onClick={() => void copyCurrentImage()} aria-label={t('creationCopyImage')} title={t('creationCopyImage')}><Copy size={17} /></button>
        <MorphSettingsDropdown value={morphPreferences} onChange={saveMorphPreferences} />
        <button className="creation-morph-gallery-button" type="button" onClick={() => setMorphGalleryOpen(true)} aria-label={t('morphSliderOpenGallery')} title={t('morphSliderOpenGallery')}><CollapseCornersIcon /></button>
      </div>
      <div className={`creation-morph-gallery cp-sidebar-scrollbar${morphGalleryOpen ? ' is-active' : ''}`} aria-hidden={!morphGalleryOpen} inert={morphGalleryOpen ? undefined : true}>
        <div className="creation-morph-gallery-grid" role="list" aria-label={t('morphSliderGallery')}>
          {rightItems.map((item, index) => <button className="creation-morph-gallery-item" type="button" role="listitem" key={item.image} onClick={() => { setMorphStartIndex(index); setMorphGalleryOpen(false); }} aria-label={t('morphSliderSelectImage', { value: index + 1 })}>
            <img src={item.image} alt={t('morphSliderImageAlt', { value: index + 1 })} />
            <span>{index + 1}</span>
          </button>)}
        </div>
      </div>
    </section>
  </main>;
}

function AccountsPreview({ provider, notify, selectedId, onSelect }: { provider: Provider; notify: Notify; selectedId: string; onSelect: (id: string) => void }) {
  const { t, locale, setLocale } = useI18n();
  const selectorRef = useRef<HTMLDivElement>(null);
  const [files, setFiles] = useState<AuthFile[]>([]); const [deepSeekKeys, setDeepSeekKeys] = useState<DeepSeekApiKey[]>([]); const [selectedDeepSeekKeyId, setSelectedDeepSeekKeyId] = useState(''); const [deepSeekBalance, setDeepSeekBalance] = useState<DeepSeekBalance | null>(null); const [deepSeekCredentialStatus, setDeepSeekCredentialStatus] = useState<DeepSeekCredentialStatus>('unknown'); const [balanceLoading, setBalanceLoading] = useState(false); const [menuOpen, setMenuOpen] = useState(false); const [pasteOpen, setPasteOpen] = useState(false); const [accountManagerOpen, setAccountManagerOpen] = useState(false); const [accountSummary, setAccountSummary] = useState<RequestLogSummary | null>(null); const [accountTrend, setAccountTrend] = useState<RequestTrendPoint[]>([]); const [configModel, setConfigModel] = useState<AvailableModel | null>(null); const [models, setModels] = useState<AvailableModel[]>([]); const [modelsLoading, setModelsLoading] = useState(false);
  useEffect(() => { setConfigModel(null); }, [provider]);
  const load = useCallback(async () => { try { const result = await authApi.list(); setFiles(result.files); onSelect(result.files.some((file) => file.id === selectedId) ? selectedId : result.files[0]?.id ?? ''); } catch (error) { notify(apiError(error, t), 'error'); } }, [notify, onSelect, selectedId, t]);
  const loadDeepSeekKeys = useCallback(async () => { try { const result = await deepSeekApi.listKeys(); setDeepSeekKeys(result.keys); setSelectedDeepSeekKeyId((current) => result.keys.some((key) => key.id === current) ? current : result.keys[0]?.id ?? ''); } catch (error) { notify(apiError(error, t), 'error'); } }, [notify, t]);
  useEffect(() => { if (provider === 'codex') void load(); else void loadDeepSeekKeys(); }, [load, loadDeepSeekKeys, provider]);
  const selected = provider === 'codex' ? files.find((file) => file.id === selectedId) ?? null : null;
  const selectedDeepSeekKey = provider === 'deepseek' ? deepSeekKeys.find((key) => key.id === selectedDeepSeekKeyId) ?? null : null;
  const logAccountId = provider === 'deepseek' ? selectedDeepSeekKeyId : selected?.accountId ?? '';
  useEffect(() => { if (!logAccountId) { setAccountSummary(null); setAccountTrend([]); return; } let active = true; setAccountSummary(null); setAccountTrend([]); gatewayApi.logs({ accountId: logAccountId, limit: 200 }).then((result) => { if (active) { setAccountSummary(result.summary); setAccountTrend(result.trend); } }).catch((error) => { if (active) notify(apiError(error, t), 'error'); }); return () => { active = false; }; }, [logAccountId, notify, t]);
  const primaryQuota = selected?.latestInspection?.windows.find((window) => window.key === 'primary') ?? null;
  const primaryUsed = primaryQuota?.usedPercent === null || primaryQuota?.usedPercent === undefined ? null : Math.min(100, Math.max(0, primaryQuota.usedPercent));
  const primaryRemaining = primaryUsed === null ? null : Math.round(100 - primaryUsed);
  const quotaColor = primaryRemaining === null ? '#b9bdc4' : primaryRemaining <= 20 ? '#ff453a' : primaryRemaining <= 50 ? '#ff9f0a' : '#34c759';
  const accountExpired = Boolean(selected?.expiresAt && selected.expiresAt <= Date.now());
  useEffect(() => { if (provider !== 'codex' || !selectedId) return; let active = true; const refresh = async (silent: boolean) => { try { await authApi.inspect(selectedId); const result = await authApi.list(); if (active) setFiles(result.files); } catch (error) { if (!silent && active) notify(apiError(error, t), 'error'); } }; void refresh(false); const interval = window.setInterval(() => void refresh(true), 30_000); return () => { active = false; window.clearInterval(interval); }; }, [notify, provider, selectedId, t]);
  useEffect(() => { if (provider !== 'codex' || !selectedId) { setModels([]); setModelsLoading(false); return; } let active = true; setModelsLoading(true); modelsApi.list(selectedId).then((result) => { if (active) setModels(result.models); }).catch((error) => { if (active) { setModels([]); notify(apiError(error, t), 'error'); } }).finally(() => { if (active) setModelsLoading(false); }); return () => { active = false; }; }, [notify, provider, selectedId, t]);
  useEffect(() => { if (provider !== 'deepseek') return; if (!selectedDeepSeekKeyId) { setModels([]); setModelsLoading(false); return; } let active = true; setModels([]); setModelsLoading(true); deepSeekApi.listModels(selectedDeepSeekKeyId).then((result) => { if (active) setModels(result.models); }).catch((error) => { if (active) { setModels([]); notify(apiError(error, t), 'error'); } }).finally(() => { if (active) setModelsLoading(false); }); return () => { active = false; }; }, [notify, provider, selectedDeepSeekKeyId, t]);
  useEffect(() => { if (provider !== 'deepseek') { setDeepSeekBalance(null); setDeepSeekCredentialStatus('unknown'); setBalanceLoading(false); return; } if (!selectedDeepSeekKeyId) { setDeepSeekBalance(null); setDeepSeekCredentialStatus('unknown'); setBalanceLoading(false); return; } let active = true; setDeepSeekBalance(null); setDeepSeekCredentialStatus('checking'); const refresh = async (silent: boolean) => { if (!silent) setBalanceLoading(true); try { const result = await deepSeekApi.balance(selectedDeepSeekKeyId); if (active) { setDeepSeekBalance(result); setDeepSeekCredentialStatus('valid'); } } catch (error) { if (active && error instanceof ApiError && error.code === 'DEEPSEEK_AUTH_REJECTED') { setDeepSeekBalance(null); setDeepSeekCredentialStatus('invalid'); } else if (!silent && active) { setDeepSeekBalance(null); setDeepSeekCredentialStatus((current) => current === 'valid' ? current : 'unknown'); notify(apiError(error, t), 'error'); } } finally { if (!silent && active) setBalanceLoading(false); } }; void refresh(false); const interval = window.setInterval(() => void refresh(true), 30_000); return () => { active = false; window.clearInterval(interval); }; }, [notify, provider, selectedDeepSeekKeyId, t]);
  const credentialCount = provider === 'deepseek' ? deepSeekKeys.length : files.length;
  useEffect(() => { if (!credentialCount) { setMenuOpen(false); setAccountManagerOpen(false); } }, [credentialCount]);
  useEffect(() => { const close = (event: PointerEvent) => { if (!selectorRef.current?.contains(event.target as Node)) setMenuOpen(false); }; document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close); }, []);
  const saveCredential = async (content: string) => { const decoded = decodeCredentialInput(content); if (!decoded) { notify(t('errorBase64Credential'), 'error'); return false; } try { await authApi.import(`codex-account-${Date.now()}.json`, decoded); notify(t('importSuccess')); await load(); return true; } catch (error) { notify(apiError(error, t), 'error'); return false; } };
  const saveDeepSeekKey = async (name: string, apiKey: string, billingCurrency: BillingCurrency) => { try { const result = await deepSeekApi.createKey(name, apiKey, billingCurrency); await loadDeepSeekKeys(); setSelectedDeepSeekKeyId(result.key.id); notify(t('deepSeekKeySaved')); return true; } catch (error) { notify(apiError(error, t), 'error'); return false; } };
  const reorder = async (ids: string[]) => { try { const result = await authApi.reorder(ids); setFiles(result.files); notify(t('accountOrderSaved')); } catch (error) { notify(apiError(error, t), 'error'); } };
  const reorderDeepSeekKeys = async (ids: string[]) => { try { const result = await deepSeekApi.reorderKeys(ids); setDeepSeekKeys(result.keys); notify(t('deepSeekKeyOrderSaved')); } catch (error) { notify(apiError(error, t), 'error'); } };
  const removeAccount = async (id: string) => { try { await authApi.delete(id); await load(); notify(t('deleteSuccess')); } catch (error) { notify(apiError(error, t), 'error'); } };
  const removeDeepSeekKey = async (id: string) => { try { await deepSeekApi.deleteKey(id); const result = await deepSeekApi.listKeys(); setDeepSeekKeys(result.keys); setSelectedDeepSeekKeyId((current) => current === id ? result.keys[0]?.id ?? '' : current); notify(t('deepSeekKeyDeleted')); } catch (error) { notify(apiError(error, t), 'error'); } };
  const deepSeekMode = provider === 'deepseek';
  const accountCurrency = deepSeekMode
    ? accountSummary?.estimatedCosts[0]?.currency ?? 'CNY'
    : 'USD';
  const costValue = accountSummary ? formatCosts(accountSummary.estimatedCosts) : '—';
  const requestValue = accountSummary ? formatNumber(accountSummary.totalRequests, locale) : '—';
  const copyOrderCode = async () => {
    if (!selected?.order_code) return;
    try {
      await navigator.clipboard.writeText(selected.order_code);
      notify(t('copied'));
    } catch {
      notify(t('errorGeneric'), 'error');
    }
  };
  const displayName = deepSeekMode ? selectedDeepSeekKey?.name ?? t('deepSeekNoKeys') : selected?.email ?? selected?.fileName ?? t('noAccountGreeting');
  const accountInfoCard = deepSeekMode
    ? <DeepSeekAccountInfoCard apiKey={selectedDeepSeekKey} status={deepSeekCredentialStatus} locale={locale} />
    : <section className="account-panel-card account-info-card"><header><h3>{t('accountInfo')}</h3>{selected && <span className={`account-info-status ${accountExpired ? 'expired' : 'normal'}`}><i />{accountExpired ? t('expired') : t('normal')}</span>}</header>{selected ? <div className="account-info-list cp-sidebar-scrollbar">{selected.order_code ? <div className="account-info-row"><span className="account-info-icon"><ReceiptText size={16} /></span><span><small>{t('orderNumber')}</small><button className="account-order-code" type="button" onClick={() => void copyOrderCode()} title={t('copy')} aria-label={t('copy')}>{selected.order_code}</button></span></div> : null}<div className="account-info-row"><span className="account-info-icon"><BadgeCheck size={16} /></span><span><small>{t('plan')}</small><strong className="account-plan-value">{selected.planType ?? '—'}</strong></span></div><div className="account-info-row"><span className="account-info-icon"><CalendarDays size={16} /></span><span><small>{t('validUntil')}</small><strong>{selected.expiresAt ? formatDate(selected.expiresAt, locale) : '—'}</strong></span></div><div className="account-info-row"><span className="account-info-icon"><Clock3 size={16} /></span><span><small>{t('addedAt')}</small><strong>{formatDate(selected.createdAt, locale)}</strong></span></div></div> : <div className="account-info-state">{t('noInformation')}</div>}</section>;
  return <main className="account-canvas"><section className={`account-white-card account-side-card${deepSeekMode ? ' deepseek' : ''}`}>
    <div className={`account-email-display${credentialCount ? ' has-accounts' : ''}`} onClick={credentialCount ? () => setAccountManagerOpen(true) : undefined} role={credentialCount ? 'button' : undefined} tabIndex={credentialCount ? 0 : undefined} onKeyDown={credentialCount ? (event) => { if (event.key === 'Enter' || event.key === ' ') setAccountManagerOpen(true); } : undefined}>
      {deepSeekMode ? <button className="account-language-button account-key-mark" type="button" aria-label={t('language')} title={t('language')} onClick={(event) => { event.stopPropagation(); setLocale(locale === 'zh' ? 'en' : 'zh'); }}><ColorKeyMark /></button> : <button className="account-language-button" type="button" aria-label={t('language')} title={t('language')} onClick={(event) => { event.stopPropagation(); setLocale(locale === 'zh' ? 'en' : 'zh'); }}><ColorMailMark /></button>}
      <strong>{displayName}</strong>
      {credentialCount ? <div className="account-dropdown" ref={selectorRef}><button className="account-dropdown-trigger" type="button" aria-label={t('switchAccount')} aria-expanded={menuOpen} onClick={(event) => { event.stopPropagation(); setMenuOpen((open) => !open); }}><ChevronDown size={16} /></button><MotionPresence>{menuOpen ? <div className="account-dropdown-menu cp-sidebar-scrollbar">{deepSeekMode ? deepSeekKeys.map((key) => <button className={key.id === selectedDeepSeekKeyId ? 'selected' : ''} type="button" key={key.id} onClick={(event) => { event.stopPropagation(); setSelectedDeepSeekKeyId(key.id); setMenuOpen(false); }}><span>{key.name}</span></button>) : files.map((file) => <button className={file.id === selectedId ? 'selected' : ''} type="button" key={file.id} onClick={(event) => { event.stopPropagation(); onSelect(file.id); setMenuOpen(false); }}><span>{file.email ?? file.fileName}</span></button>)}</div> : null}</MotionPresence></div> : null}
    </div>
    <button className="account-add-button" aria-label={deepSeekMode ? t('deepSeekKeyTitle') : t('pasteCredentialTitle')} title={deepSeekMode ? t('deepSeekKeyTitle') : t('pasteCredentialTitle')} onClick={() => setPasteOpen(true)}><Plus size={17} /></button>
    <img className={deepSeekMode ? 'deepseek-assistant' : 'chatgpt-assistant'} src={deepSeekMode ? deepSeekAssistant : chatGptRobot} alt="" />
  </section><section className="account-main-grid"><div className="account-main-top"><section className="account-panel-card account-usage-card"><h3>{t('accountCost')}</h3><SevenDayTrend id="cost" values={accountTrend.map((point) => costForCurrency(point.estimatedCosts, accountCurrency))} label={t('sevenDayCostTrend')} /><button className="account-usage-value" type="button" disabled={!accountSummary} onClick={() => notify(costValue)}>{costValue}</button><small>{t('accountCostHint')}</small></section><section className="account-panel-card account-usage-card"><h3>{t('accountRequests')}</h3><SevenDayTrend id="requests" values={accountTrend.map((point) => point.requestCount)} label={t('sevenDayRequestTrend')} /><button className="account-usage-value" type="button" disabled={!accountSummary} onClick={() => notify(requestValue)}>{requestValue}</button><small>{accountSummary ? t('accountSuccessRate', { value: accountSummary.totalRequests ? Math.round((accountSummary.successCount / accountSummary.totalRequests) * 100) : 0 }) : t('loading')}</small></section>{accountInfoCard}</div><div className="account-main-bottom">{deepSeekMode ? <DeepSeekBalanceCard balance={deepSeekBalance} loading={balanceLoading} /> : <section className="account-panel-card account-quota-card"><h3>{t('quotaOverview')}</h3><div className="account-quota-ring"><svg viewBox="0 0 120 120" aria-hidden="true"><circle className="account-quota-track" cx="60" cy="60" r="50" pathLength="100" /><circle className="account-quota-value" cx="60" cy="60" r="50" pathLength="100" stroke={quotaColor} strokeDasharray="100" strokeDashoffset={100 - (primaryRemaining ?? 0)} /></svg><div><strong style={{ color: quotaColor }}>{primaryRemaining === null ? '—' : `${primaryRemaining}%`}</strong><span>{t('quotaRemaining')}</span></div></div></section>}<section className="account-panel-card account-model-card"><header><h3>{t('availableModels')}</h3><span>{models.length}</span></header><div className="account-model-list cp-sidebar-scrollbar">{modelsLoading ? <AccountModelSkeleton label={t('loading')} /> : models.length ? models.map((model) => <div className="account-model-row" key={model.id}><span className="account-model-icon">{deepSeekMode ? <DeepSeekMark /> : <OpenAiMark />}</span><strong>{model.displayName}</strong><button className="account-model-config-button" aria-label={t('openModelConfig')} title={t('openModelConfig')} onClick={() => setConfigModel(model)}><MousePointerClick size={17} strokeWidth={2.2} /></button></div>) : <div className="account-model-state">{t('noModels')}</div>}</div></section></div></section>
    <MotionPresence>{pasteOpen ? deepSeekMode ? <DeepSeekKeyDialog onClose={() => setPasteOpen(false)} onSave={saveDeepSeekKey} /> : <AccountCredentialDialog onClose={() => setPasteOpen(false)} onSave={saveCredential} /> : null}</MotionPresence>
    <MotionPresence>{configModel ? <ModelConfigDialog model={configModel} deepSeekKeyId={deepSeekMode ? selectedDeepSeekKeyId : undefined} notify={notify} onClose={() => setConfigModel(null)} /> : null}</MotionPresence>
    <MotionPresence>{accountManagerOpen ? deepSeekMode && deepSeekKeys.length ? <DeepSeekKeyManagerDialog keys={deepSeekKeys} selectedId={selectedDeepSeekKeyId} notify={notify} onSelect={setSelectedDeepSeekKeyId} onReorder={reorderDeepSeekKeys} onDelete={removeDeepSeekKey} onClose={() => setAccountManagerOpen(false)} /> : !deepSeekMode && files.length ? <AccountManagerDialog files={files} selectedId={selectedId} notify={notify} onSelect={onSelect} onReorder={reorder} onDelete={removeAccount} onAccountsChanged={load} onClose={() => setAccountManagerOpen(false)} /> : null : null}</MotionPresence>
  </main>;
}

function decodeCredentialInput(input: string) {
  try { const normalized = input.replace(/\s/g, ''); if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null; const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='); const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)); const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? JSON.stringify(parsed) : null; } catch { return null; }
}

function AccountCredentialDialog({ onClose, onSave }: { onClose: () => void; onSave: (content: string) => Promise<boolean> }) {
  const { t } = useI18n(); const [content, setContent] = useState(''); const [saving, setSaving] = useState(false);
  return <div className="credential-dialog-layer" role="dialog" aria-modal="true" aria-label={t('pasteCredentialTitle')}><button className="credential-dialog-backdrop" aria-label={t('close')} onClick={onClose} /><section className="credential-dialog"><header><h3>{t('pasteCredentialTitle')}</h3><button className="credential-dialog-close" onClick={onClose} aria-label={t('close')}><X size={20} /></button></header><textarea className="cp-sidebar-scrollbar" value={content} onChange={(event) => setContent(event.target.value)} placeholder={t('credentialPastePlaceholder')} spellCheck={false} /><footer><button className="credential-save-button" disabled={saving || !content.trim()} onClick={async () => { setSaving(true); if (await onSave(content)) onClose(); setSaving(false); }}>{saving ? t('loading') : t('saveCredential')}</button></footer></section></div>;
}

function DeepSeekKeyDialog({ onClose, onSave }: { onClose: () => void; onSave: (name: string, apiKey: string, billingCurrency: BillingCurrency) => Promise<boolean> }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [billingCurrency, setBillingCurrency] = useState<BillingCurrency>('CNY');
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (saving || !name.trim() || !apiKey.trim()) return;
    setSaving(true);
    try { if (await onSave(name, apiKey, billingCurrency)) onClose(); } finally { setSaving(false); }
  };
  return <div className="credential-dialog-layer" role="dialog" aria-modal="true" aria-label={t('deepSeekKeyTitle')}><button className="credential-dialog-backdrop" aria-label={t('close')} onClick={onClose} /><section className="credential-dialog deepseek-key-dialog"><header><h3>{t('deepSeekKeyTitle')}</h3><button className="credential-dialog-close" onClick={onClose} aria-label={t('close')}><X size={20} /></button></header><div className="deepseek-key-fields"><label><span>{t('deepSeekRequestAddress')}</span><input value={deepSeekBaseUrl} readOnly /></label><div className="deepseek-key-field"><span>{t('deepSeekBillingCurrency')}</span><CustomSelect className="deepseek-currency-select" tone="dark" value={billingCurrency} ariaLabel={t('deepSeekBillingCurrency')} options={[{ value: 'CNY', label: t('deepSeekCurrencyCny') }, { value: 'USD', label: t('deepSeekCurrencyUsd') }]} onChange={(value) => setBillingCurrency(value as BillingCurrency)} /><small>{t('deepSeekBillingCurrencyHint')}</small></div><label><span>{t('deepSeekKeyName')}</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder={t('deepSeekKeyNamePlaceholder')} autoFocus /></label><label><span>{t('deepSeekApiKey')}</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} maxLength={512} placeholder={t('deepSeekApiKeyPlaceholder')} autoComplete="off" /></label></div><footer><button className="credential-save-button" disabled={saving || !name.trim() || !apiKey.trim()} onClick={() => void submit()}>{saving ? <SolnSpin label={t('loading')} /> : t('saveCredential')}</button></footer></section></div>;
}

function DeepSeekKeyManagerDialog({ keys, selectedId, notify, onSelect, onReorder, onDelete, onClose }: {
  keys: DeepSeekApiKey[]; selectedId: string; onSelect: (id: string) => void;
  notify: Notify;
  onReorder: (ids: string[]) => Promise<void>; onDelete: (id: string) => Promise<void>; onClose: () => void;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState(keys);
  const [saving, setSaving] = useState(false);
  useEffect(() => setItems(keys), [keys]);
  const move = async (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= items.length || saving) return;
    const next = [...items]; [next[index], next[target]] = [next[target]!, next[index]!];
    setItems(next); setSaving(true);
    try { await onReorder(next.map((key) => key.id)); } finally { setSaving(false); }
  };
  const remove = async (id: string) => {
    if (saving) return;
    setSaving(true);
    try { await onDelete(id); } finally { setSaving(false); }
  };
  const copyName = async (name: string) => {
    try { await navigator.clipboard.writeText(name); notify(t('copied')); }
    catch { notify(t('errorGeneric'), 'error'); }
  };
  return <div className="account-manager-layer" role="dialog" aria-modal="true" aria-label={t('deepSeekKeyListTitle')}>
    <button className="account-manager-backdrop" aria-label={t('close')} onClick={onClose} />
    <section className="account-manager-dialog">
      <header><h3>{t('deepSeekKeyListTitle')}</h3><button className="credential-dialog-close" aria-label={t('close')} onClick={onClose}><X size={20} /></button></header>
      <div className="account-manager-list cp-sidebar-scrollbar">{items.map((key, index) => <div className={`account-manager-row${key.id === selectedId ? ' selected' : ''}`} key={key.id}>
        <div className="account-manager-select"><button className="account-manager-copy-name" type="button" title={t('copy')} onClick={() => void copyName(key.name)}>{key.name}</button><button className="account-manager-select-meta" type="button" aria-label={t('switchAccount')} onClick={() => { onSelect(key.id); onClose(); }}><span className="account-manager-plan-tag">{key.maskedKey}</span></button></div>
        <div className="account-manager-actions"><button aria-label={t('moveUp')} disabled={index === 0 || saving} onClick={() => void move(index, -1)}><ArrowUp size={15} /></button><button aria-label={t('moveDown')} disabled={index === items.length - 1 || saving} onClick={() => void move(index, 1)}><ArrowDown size={15} /></button><button className="danger" aria-label={t('delete')} disabled={saving} onClick={() => void remove(key.id)}><Trash2 size={15} /></button></div>
      </div>)}</div>
    </section>
  </div>;
}

function AccountManagerDialog({ files, selectedId, notify, onSelect, onReorder, onDelete, onAccountsChanged, onClose }: {
  files: AuthFile[]; selectedId: string; onSelect: (id: string) => void;
  notify: Notify; onReorder: (ids: string[]) => Promise<void>; onDelete: (id: string) => Promise<void>;
  onAccountsChanged: () => Promise<void>; onClose: () => void;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState(files);
  const [saving, setSaving] = useState(false);
  const [resetStates, setResetStates] = useState<Record<string, { loading: boolean; availableCount: number | null; error: boolean }>>({});
  const [pendingReset, setPendingReset] = useState<{ file: AuthFile; idempotencyKey: string } | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  useEffect(() => setItems(files), [files]);
  const resetAccountIds = files.filter((file) => !file.disabled).map((file) => file.id).join(',');
  useEffect(() => {
    let active = true;
    const eligible = files.filter((file) => !file.disabled);
    setResetStates(Object.fromEntries(eligible.map((file) => [file.id, { loading: true, availableCount: null, error: false }])));
    const loadResets = async () => {
      for (const file of eligible) {
        if (!active) return;
        try {
          const result = await authApi.rateLimitResetStatus(file.id);
          if (active) setResetStates((current) => ({ ...current, [file.id]: { loading: false, availableCount: result.availableCount, error: false } }));
        } catch (error) {
          if (!active) return;
          setResetStates((current) => ({ ...current, [file.id]: { loading: false, availableCount: null, error: true } }));
          if (error instanceof ApiError && error.code === 'CODEX_CLI_NOT_FOUND') {
            setResetStates(Object.fromEntries(eligible.map((item) => [item.id, { loading: false, availableCount: null, error: true }])));
            return;
          }
        }
      }
    };
    void loadResets();
    return () => { active = false; };
  }, [resetAccountIds]);
  const move = async (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= items.length || saving) return;
    const next = [...items]; [next[index], next[target]] = [next[target]!, next[index]!];
    setItems(next); setSaving(true);
    try { await onReorder(next.map((item) => item.id)); } finally { setSaving(false); }
  };
  const consumeReset = async () => {
    if (!pendingReset || resettingId) return;
    setResettingId(pendingReset.file.id);
    try {
      const result = await authApi.consumeRateLimitReset(pendingReset.file.id, pendingReset.idempotencyKey);
      setResetStates((current) => ({ ...current, [pendingReset.file.id]: { loading: false, availableCount: result.availableCount, error: false } }));
      const message = result.outcome === 'reset' ? t('rateLimitResetSuccess')
        : result.outcome === 'alreadyRedeemed' ? t('rateLimitResetAlreadyRedeemed')
          : result.outcome === 'nothingToReset' ? t('rateLimitResetNothingToReset') : t('rateLimitResetNoCredit');
      notify(message, result.outcome === 'reset' || result.outcome === 'alreadyRedeemed' ? 'success' : 'error');
      setPendingReset(null);
      await authApi.inspect(pendingReset.file.id).catch(() => undefined);
      await onAccountsChanged();
    } catch (error) {
      notify(apiError(error, t), 'error');
    } finally {
      setResettingId(null);
    }
  };
  const copyAccountName = async (name: string) => {
    try { await navigator.clipboard.writeText(name); notify(t('copied')); }
    catch { notify(t('errorGeneric'), 'error'); }
  };
  return <div className="account-manager-layer" role="dialog" aria-modal="true" aria-label={t('accountListTitle')}>
    <button className="account-manager-backdrop" aria-label={t('close')} onClick={onClose} />
    <section className="account-manager-dialog">
      <header><h3>{t('accountListTitle')}</h3><button className="credential-dialog-close" aria-label={t('close')} onClick={onClose}><X size={20} /></button></header>
      <div className="account-manager-list cp-sidebar-scrollbar">{items.map((file, index) => <div className={`account-manager-row${file.id === selectedId ? ' selected' : ''}`} key={file.id}>
        <div className="account-manager-select"><button className="account-manager-copy-name" type="button" title={t('copy')} onClick={() => void copyAccountName(file.email ?? file.fileName)}>{file.email ?? file.fileName}</button><button className="account-manager-select-meta" type="button" aria-label={t('switchAccount')} onClick={() => { onSelect(file.id); onClose(); }}><span className="account-manager-plan-tag">{file.planType ?? 'Codex'}</span><span className={`account-manager-status-tag${file.expiresAt && file.expiresAt <= Date.now() ? ' expired' : ' normal'}`}><i />{file.expiresAt && file.expiresAt <= Date.now() ? t('expired') : t('normal')}</span></button></div>
        {resetStates[file.id]?.availableCount ? <button className="account-manager-reset" type="button" disabled={Boolean(resettingId)} title={t('rateLimitResetAvailable', { value: resetStates[file.id]!.availableCount! })} onClick={() => setPendingReset({ file, idempotencyKey: crypto.randomUUID() })}><span>{t('rateLimitResetAvailable', { value: resetStates[file.id]!.availableCount! })}</span></button> : null}
        <div className="account-manager-actions"><button aria-label={t('moveUp')} disabled={index === 0 || saving} onClick={() => void move(index, -1)}><ArrowUp size={15} /></button><button aria-label={t('moveDown')} disabled={index === items.length - 1 || saving} onClick={() => void move(index, 1)}><ArrowDown size={15} /></button><button className="danger" aria-label={t('delete')} disabled={saving} onClick={() => void onDelete(file.id)}><Trash2 size={15} /></button></div>
      </div>)}</div>
    </section>
    <MotionPresence>{pendingReset ? <Dialog layerClassName="account-reset-dialog-layer" title={t('rateLimitResetTitle')} onClose={() => { if (!resettingId) setPendingReset(null); }}><p>{t('rateLimitResetBody', { account: pendingReset.file.email ?? pendingReset.file.fileName })}</p><div className="dialog-actions"><Button variant="secondary" disabled={Boolean(resettingId)} onClick={() => setPendingReset(null)}>{t('cancel')}</Button><Button variant="danger" disabled={Boolean(resettingId)} onClick={() => void consumeReset()}>{resettingId ? <SolnSpin label={t('loading')} /> : null}{t('rateLimitResetConfirm')}</Button></div></Dialog> : null}</MotionPresence>
  </div>;
}

function PageIntro({ title, subtitle, actions }: { title: string; subtitle: string; actions?: ReactNode }) { return <div className="page-intro"><div><h2>{title}</h2><p>{subtitle}</p></div>{actions && <div className="intro-actions">{actions}</div>}</div>; }
function Button({ children, variant = 'primary', disabled, onClick, type = 'button' }: { children: ReactNode; variant?: 'primary' | 'secondary' | 'danger' | 'plain'; disabled?: boolean; onClick?: () => void; type?: 'button' | 'submit' }) { return <button type={type} className={`action ${variant}`} disabled={disabled} onClick={onClick}>{children}</button>; }
function Spinner() { return <LoaderCircle className="spin" size={16} />; }
function Card({ children, className = '' }: { children: ReactNode; className?: string }) { return <section className={`surface ${className}`}>{children}</section>; }
function Empty({ icon: Icon, title, body }: { icon: typeof FileKey2; title: string; body: string }) { return <div className="empty"><Icon size={30} /><strong>{title}</strong><p>{body}</p></div>; }
function formatDate(value: number | null, locale: string) { return value ? new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(value) : '—'; }
function formatNumber(value: number, locale: string) { return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en').format(value); }
function formatCosts(costs: RequestLogSummary['estimatedCosts']) { return costs.length ? costs.map((cost) => `${cost.currency === 'CNY' ? '¥' : '$'}${cost.amount.toFixed(6)}`).join(' / ') : '—'; }
function costForCurrency(costs: RequestTrendPoint['estimatedCosts'], currency: 'USD' | 'CNY') { return costs.find((cost) => cost.currency === currency)?.amount ?? 0; }
function SevenDayTrend({ id, values, label }: { id: string; values: number[]; label: string }) {
  const series = values.length === 7 ? values : Array(7).fill(0) as number[];
  const width = 300; const height = 72; const padding = 5;
  const max = Math.max(...series, 0);
  const points = series.map((value, index) => ({
    x: padding + index * ((width - padding * 2) / 6),
    y: max === 0 ? height * .68 : padding + (1 - value / max) * (height - padding * 2),
  }));
  const line = points.reduce((path, point, index) => {
    if (index === 0) return `M ${point.x} ${point.y}`;
    const previous = points[index - 1]!; const middle = (previous.x + point.x) / 2;
    return `${path} C ${middle} ${previous.y}, ${middle} ${point.y}, ${point.x} ${point.y}`;
  }, '');
  const area = `${line} L ${points.at(-1)!.x} ${height} L ${points[0]!.x} ${height} Z`;
  return <svg className="account-seven-day-trend" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={label}>
    <defs><linearGradient id={`${id}-trend-fill`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#111113" stopOpacity=".13" /><stop offset="1" stopColor="#111113" stopOpacity="0" /></linearGradient></defs>
    <path className="trend-guide" d={`M ${padding} ${height - 1} H ${width - padding}`} />
    <path className="trend-area" d={area} fill={`url(#${id}-trend-fill)`} />
    <path className="trend-line" d={line} />
    {points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="2.3" />)}
  </svg>;
}
function apiError(error: unknown, t: ReturnType<typeof useI18n>['t']) { return t(errorKey(error instanceof ApiError ? error.code : '')); }
function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: string | number }) { return <article className="stat"><span>{icon}</span><div><small>{label}</small><strong>{value}</strong></div></article>; }

function HomeView({ notify, onNavigate }: { notify: Notify; onNavigate: (page: Page) => void }) {
  const { t, locale } = useI18n(); const [files, setFiles] = useState<AuthFile[]>([]); const [summary, setSummary] = useState<RequestLogSummary | null>(null); const [loading, setLoading] = useState(true);
  const load = useCallback(async () => { setLoading(true); try { const [auth, logs] = await Promise.all([authApi.list(), gatewayApi.logs({ limit: 100 })]); setFiles(auth.files); setSummary(logs.summary); } catch (error) { notify(apiError(error, t), 'error'); } finally { setLoading(false); } }, [notify, t]); useEffect(() => { void load(); }, [load]);
  const enabledCount = files.filter((file) => !file.disabled).length;
  const healthyCount = files.filter((file) => !file.disabled && file.latestInspection?.status === 'healthy').length;
  const totalRequests = summary?.totalRequests ?? 0;
  const successRate = totalRequests ? Math.round(((summary?.successCount ?? 0) / totalRequests) * 100) : 0;
  const activityBars = Array.from({ length: 18 }, (_, index) => {
    const seed = totalRequests + enabledCount * 7 + index * 13;
    return 22 + (seed % 70);
  });
  return <div className="view pulse-view">
    <div className="pulse-heading"><div><span className="pulse-eyebrow">{t('dashboardKicker')}</span><h2>{t('dashboard')}</h2><p>{t('dashboardSubtitle')}</p></div><div className="pulse-heading-actions"><span className="pulse-live"><i />{t('localOnly')}</span><Button variant="secondary" onClick={() => void load()} disabled={loading}>{loading ? <Spinner /> : <RefreshCw size={16} />}{t('refresh')}</Button></div></div>
    <div className="pulse-layout">
      <section className="pulse-hero">
        <div className="pulse-hero-top"><span className="pulse-logo"><ShieldCheck size={17} /></span><span>{t('dashboardHeroBadge')}</span><button aria-label={t('modelsConfig')} onClick={() => onNavigate('models')}><ArrowUpRight size={18} /></button></div>
        <div className="pulse-hero-copy"><span className="pulse-chip">{t('dashboardHeroChip')}</span><h3>{t('dashboardHeroTitle')}</h3><p>{t('dashboardHeroBody')}</p><div className="pulse-hero-actions"><Button onClick={() => onNavigate('auth')}><FileKey2 size={16} />{t('dashboardOpenCredentials')}</Button><button className="pulse-text-action" onClick={() => onNavigate('monitor')}>{t('monitoring')} <ArrowUpRight size={15} /></button></div></div>
        <div className="pulse-hero-stats"><div><strong>{formatNumber(enabledCount, locale)}</strong><span>{t('activeFiles')}</span></div><div><strong>{formatNumber(healthyCount, locale)}</strong><span>{t('healthy')}</span></div><div><strong>{formatNumber(summary?.totalTokens ?? 0, locale)}</strong><span>{t('totalTokens')}</span></div></div>
        <div className="pulse-credential-strip"><div><span className="pulse-strip-label">{t('dashboardCredentials')}</span><span className="pulse-strip-count">{files.length}</span></div><div className="pulse-avatars">{files.slice(0, 4).map((file) => <span key={file.id} title={file.email ?? file.fileName}>{(file.email ?? file.fileName).slice(0, 1).toUpperCase()}</span>)}{files.length > 4 && <span>+{files.length - 4}</span>}</div><button onClick={() => onNavigate('auth')} aria-label={t('authFiles')}><ArrowUpRight size={16} /></button></div>
      </section>
      <section className="pulse-card pulse-assistant"><div className="pulse-card-heading"><div><span className="pulse-card-kicker">{t('dashboardGatewayKicker')}</span><h3>{t('dashboardGatewayTitle')}</h3></div><Bot size={20} /></div><div className="pulse-wave" aria-hidden="true">{activityBars.slice(0, 12).map((height, index) => <i key={index} style={{ height: `${Math.max(25, height - 8)}%` }} />)}</div><div className="pulse-gateway-status"><span className={`pulse-status-dot ${enabledCount ? 'on' : ''}`} /><strong>{enabledCount ? t('dashboardGatewayReady') : t('dashboardGatewayEmpty')}</strong><small>{enabledCount ? t('dashboardGatewayBody') : t('emptyBody')}</small></div><button className="pulse-outline-action" onClick={() => onNavigate('models')}>{t('modelsConfig')} <ArrowUpRight size={15} /></button></section>
      <section className="pulse-card pulse-activity"><div className="pulse-card-heading"><div><span className="pulse-card-kicker">{t('dashboardActivityKicker')}</span><h3>{t('dashboardActivityTitle')}</h3></div><Activity size={20} /></div><div className="pulse-ring" style={{ '--ring-progress': `${successRate * 3.6}deg` } as CSSProperties}><div><strong>{formatNumber(totalRequests, locale)}</strong><span>{t('totalRequests')}</span></div></div><div className="pulse-metrics"><div><span className="metric-dot blue" /><strong>{formatNumber(summary?.successCount ?? 0, locale)}</strong><small>{t('successRequests')}</small></div><div><span className="metric-dot red" /><strong>{formatNumber(summary?.failureCount ?? 0, locale)}</strong><small>{t('failedRequests')}</small></div></div><button className="pulse-outline-action" onClick={() => onNavigate('logs')}>{t('dashboardViewLogs')} <ArrowUpRight size={15} /></button></section>
      <section className="pulse-card pulse-progress"><div className="pulse-card-heading"><div><span className="pulse-card-kicker">{t('dashboardProgressKicker')}</span><h3>{t('dashboardProgressTitle')}</h3></div><span className="pulse-period">{t('dashboardRecentRequests')}</span></div><div className="pulse-bars">{activityBars.map((height, index) => <i key={index} className={index > activityBars.length - 5 ? 'muted' : ''} style={{ height: `${height}%` }} />)}</div><div className="pulse-progress-footer"><div><span className="metric-dot blue" />{t('successRequests')}</div><div><span className="metric-dot pale" />{t('failedRequests')}</div><div className="pulse-progress-summary"><strong>{successRate}%</strong><span>{t('dashboardSuccessRate')}</span></div><div className="pulse-progress-summary"><strong>{summary?.averageLatencyMs ? `${Math.round(summary.averageLatencyMs)}ms` : '—'}</strong><span>{t('averageLatency')}</span></div><div className="pulse-progress-summary"><strong>{formatNumber(summary?.totalTokens ?? 0, locale)}</strong><span>{t('dashboardTokens')}</span></div></div></section>
    </div>
  </div>;
}

function AuthView({ notify, onOpenMonitoring }: { notify: Notify; onOpenMonitoring: () => void }) {
  const { t, locale } = useI18n(); const inputRef = useRef<HTMLInputElement>(null); const [files, setFiles] = useState<AuthFile[]>([]); const [query, setQuery] = useState(''); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState<string | null>(null); const [pasteOpen, setPasteOpen] = useState(false);
  const load = useCallback(async () => { setLoading(true); try { setFiles((await authApi.list()).files); } catch (error) { notify(apiError(error, t), 'error'); } finally { setLoading(false); } }, [notify, t]); useEffect(() => { void load(); }, [load]);
  const importContent = async (fileName: string, content: string) => { try { await authApi.import(fileName, content); notify(t('importSuccess')); await load(); return true; } catch (error) { notify(apiError(error, t), 'error'); return false; } }; const upload = async (file: File) => { setBusy('upload'); try { await importContent(file.name, await file.text()); } finally { setBusy(null); } };
  const run = async (file: AuthFile, action: () => Promise<unknown>, message: TranslationKey) => { setBusy(file.id); try { await action(); notify(t(message)); await load(); } catch (error) { notify(apiError(error, t), 'error'); } finally { setBusy(null); } };
  const remove = async (file: AuthFile) => { if (!window.confirm(`${t('deleteTitle')}\n${file.fileName}`)) return; await run(file, () => authApi.delete(file.id), 'deleteSuccess'); }; const filtered = files.filter((file) => `${file.email ?? ''} ${file.fileName}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="view"><PageIntro title={t('authTitle')} subtitle={t('authSubtitle')} actions={<><Button variant="secondary" onClick={() => setPasteOpen(true)}><Clipboard size={16} />{t('pasteJson')}</Button><Button onClick={() => inputRef.current?.click()} disabled={busy === 'upload'}>{busy === 'upload' ? <Spinner /> : <Upload size={16} />}{t('uploadJson')}</Button><input ref={inputRef} hidden type="file" accept=".json,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ''; }} /></>} /><div className="stat-grid three"><Stat icon={<FileKey2 />} label={t('allFiles')} value={files.length} /><Stat icon={<ShieldCheck />} label={t('activeFiles')} value={files.filter((file) => !file.disabled).length} /><Stat icon={<Monitor />} label={t('uncheckedFiles')} value={files.filter((file) => !file.latestInspection).length} /></div><Card><div className="toolbar"><div className="search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('searchPlaceholder')} /></div><Button variant="plain" onClick={onOpenMonitoring}><Activity size={16} />{t('monitoring')}</Button></div>{loading ? <div className="loading"><Spinner />{t('loading')}</div> : filtered.length ? <div className="table-wrap cp-sidebar-scrollbar"><table><thead><tr><th>{t('account')}</th><th>{t('fileName')}</th><th>{t('plan')}</th><th>{t('tokenExpiry')}</th><th>{t('state')}</th><th /></tr></thead><tbody>{filtered.map((file) => <tr key={file.id}><td><div className="account"><span className="avatar-letter">{(file.email ?? file.fileName).slice(0, 1).toUpperCase()}</span><span><strong>{file.email ?? t('unknownAccount')}</strong><small>{file.accountId ?? '—'}</small></span></div></td><td>{file.fileName}</td><td><span className="pill">{file.planType ?? t('unknown')}</span></td><td>{file.expiresAt ? formatDate(file.expiresAt, locale) : <span className="muted">{t('managedAutomatically')}</span>}</td><td><Status status={file.disabled ? 'disabled' : file.latestInspection?.status ?? null} /></td><td><div className="row-actions"><button title={t('inspect')} disabled={!!busy || file.disabled} onClick={() => void run(file, () => authApi.inspect(file.id), 'inspectionDone')}>{busy === file.id ? <Spinner /> : <Activity size={15} />}</button><button title={t('download')} disabled={!!busy} onClick={() => void authApi.download(file)}><Download size={15} /></button><button title={file.disabled ? t('enable') : t('disable')} disabled={!!busy} onClick={() => void run(file, () => authApi.setDisabled(file.id, !file.disabled), 'statusSaved')}>{file.disabled ? <Power size={15} /> : <PowerOff size={15} />}</button><button className="danger-icon" title={t('delete')} disabled={!!busy} onClick={() => void remove(file)}><Trash2 size={15} /></button></div></td></tr>)}</tbody></table></div> : <Empty icon={FileKey2} title={t('emptyTitle')} body={t('emptyBody')} />}</Card><MotionPresence>{pasteOpen ? <PasteDialog onClose={() => setPasteOpen(false)} onSave={async (name, content) => { if (await importContent(name, content)) setPasteOpen(false); }} /> : null}</MotionPresence></div>;
}
function PasteDialog({ onClose, onSave }: { onClose: () => void; onSave: (name: string, content: string) => Promise<void> }) { const { t } = useI18n(); const [name, setName] = useState('codex-account.json'); const [content, setContent] = useState(''); const [saving, setSaving] = useState(false); return <Dialog title={t('pasteTitle')} onClose={onClose}><p>{t('pasteBody')}</p><label>{t('jsonFileName')}<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>{t('jsonContent')}<textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder={t('jsonPlaceholder')} spellCheck={false} /></label><div className="dialog-actions"><Button variant="secondary" onClick={onClose}>{t('cancel')}</Button><Button disabled={saving || !name.trim() || !content.trim()} onClick={async () => { setSaving(true); await onSave(name, content); setSaving(false); }}>{saving ? <Spinner /> : <Save size={16} />}{t('saveCredential')}</Button></div></Dialog>; }

const statusLabels: Record<string, TranslationKey> = { healthy: 'statusHealthy', quota_warning: 'statusQuotaWarning', quota_exhausted: 'statusQuotaExhausted', auth_error: 'statusAuthError', configuration_error: 'statusConfigurationError', network_error: 'statusNetworkError', disabled: 'statusDisabled' };
function Status({ status }: { status: InspectionStatus | null }) { const { t } = useI18n(); if (!status) return <span className="status neutral">{t('notChecked')}</span>; return <span className={`status ${status === 'healthy' ? 'good' : status.includes('error') || status === 'quota_exhausted' ? 'bad' : status === 'disabled' ? 'neutral' : 'warn'}`}><i />{t(statusLabels[status] ?? 'notChecked')}</span>; }

function MonitorView({ notify }: { notify: Notify }) { const { t, locale } = useI18n(); const [files, setFiles] = useState<AuthFile[]>([]); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const load = useCallback(async () => { setLoading(true); try { setFiles((await monitoringApi.get()).files); } catch (error) { notify(apiError(error, t), 'error'); } finally { setLoading(false); } }, [notify, t]); useEffect(() => { void load(); }, [load]); const inspectAll = async () => { setBusy(true); try { await monitoringApi.inspectAll(); notify(t('inspectionDone')); await load(); } catch (error) { notify(apiError(error, t), 'error'); } finally { setBusy(false); } }; return <div className="view"><PageIntro title={t('monitorTitle')} subtitle={t('monitorSubtitle')} actions={<><Button variant="secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={16} />{t('refresh')}</Button><Button onClick={() => void inspectAll()} disabled={busy || !files.length}>{busy ? <Spinner /> : <Gauge size={16} />}{t('runInspection')}</Button></>} /><Card>{loading ? <div className="loading"><Spinner />{t('loading')}</div> : files.length ? <div className="monitor-list">{files.map((file) => <article className="monitor-row" key={file.id}><div className="account"><span className="avatar-letter">{(file.email ?? file.fileName).slice(0, 1).toUpperCase()}</span><span><strong>{file.email ?? t('unknownAccount')}</strong><small>{file.planType ?? 'Codex'} · {file.latestInspection ? formatDate(file.latestInspection.inspectedAt, locale) : t('noInspection')}</small></span></div><div className="monitor-result"><Status status={file.disabled ? 'disabled' : file.latestInspection?.status ?? null} />{file.latestInspection?.windows.map((window) => <Quota key={window.key} window={window} />)}</div></article>)}</div> : <Empty icon={Monitor} title={t('emptyTitle')} body={t('emptyBody')} />}</Card></div>; }
function Quota({ window }: { window: { usedPercent: number | null; key: string; resetAt: number | null } }) { const { t, locale } = useI18n(); const used = Math.min(100, Math.max(0, window.usedPercent ?? 0)); return <div className="quota"><div><span>{window.key === 'primary' ? t('quotaPrimary') : t('quotaSecondary')}</span><small>{window.usedPercent === null ? '—' : t('used', { value: Math.round(used) })}</small></div><div className="quota-track"><i style={{ width: `${used}%` }} /></div>{window.resetAt && <small>{t('resets', { time: new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(window.resetAt) })}</small>}</div>; }

function ModelsView({ notify }: { notify: Notify }) { const { t } = useI18n(); const [files, setFiles] = useState<AuthFile[]>([]); const [models, setModels] = useState<AvailableModel[]>([]); const [fileId, setFileId] = useState(''); const [selected, setSelected] = useState(''); const [loading, setLoading] = useState(false); const [downloading, setDownloading] = useState<string | null>(null); const fetchModels = useCallback(async (id: string) => { setLoading(true); try { const result = await modelsApi.list(id); setModels(result.models); setSelected(result.models[0]?.id ?? ''); } catch (error) { notify(apiError(error, t), 'error'); } finally { setLoading(false); } }, [notify, t]); useEffect(() => { authApi.list().then((result) => { const active = result.files.filter((file) => !file.disabled); setFiles(active); if (active[0]) { setFileId(active[0].id); void fetchModels(active[0].id); } }).catch((error) => notify(apiError(error, t), 'error')); }, [fetchModels, notify, t]); const download = async (kind: 'auth' | 'config') => { setDownloading(kind); try { if (kind === 'auth') await modelsApi.downloadAuth(); else if (selected) await modelsApi.downloadConfig(selected); notify(kind === 'auth' ? t('authDownloadDone') : t('configDownloadDone')); } catch (error) { notify(apiError(error, t), 'error'); } finally { setDownloading(null); } }; return <div className="view"><PageIntro title={t('modelsTitle')} subtitle={t('modelsSubtitle')} actions={<Button onClick={() => fileId && void fetchModels(fileId)} disabled={loading || !fileId}>{loading ? <Spinner /> : <RefreshCw size={16} />}{t('fetchModels')}</Button>} /><Card><div className="field-inline"><span>{t('modelAccount')}</span><CustomSelect className="field-custom-select" value={fileId} ariaLabel={t('modelAccount')} placeholder={t('noInformation')} disabled={!files.length} options={files.map((file) => ({ value: file.id, label: file.email ?? file.fileName, description: file.planType ?? t('noInformation') }))} onChange={(id) => { setFileId(id); void fetchModels(id); }} /></div></Card><div className="models-grid"><Card><div className="surface-head"><div><h3>{t('availableModels')}</h3><p>{models.length}</p></div></div>{loading ? <div className="loading"><Spinner />{t('loading')}</div> : models.length ? <div className="model-list">{models.map((model) => <button className={`model-row ${selected === model.id ? 'selected' : ''}`} key={model.id} onClick={() => setSelected(model.id)}><span className="model-icon"><Sparkles size={16} /></span><span><strong>{model.displayName}</strong><small>{model.id}</small></span>{selected === model.id && <Check size={17} />}</button>)}</div> : <Empty icon={Sparkles} title={t('noModels')} body={t('noModelsBody')} />}</Card><Card><div className="surface-head"><div><h3>{t('clientFilesTitle')}</h3><p>{t('clientFilesBody')}</p></div></div><div className="selected-model"><small>{t('configModel')}</small><strong>{models.find((model) => model.id === selected)?.displayName ?? '—'}</strong><code>{selected || '—'}</code></div><Button variant="secondary" onClick={() => void download('auth')} disabled={!!downloading}><FileJson2 size={16} />auth.json {downloading === 'auth' && <Spinner />}</Button><Button variant="secondary" onClick={() => void download('config')} disabled={!selected || !!downloading}><Code2 size={16} />config.toml {downloading === 'config' && <Spinner />}</Button><p className="warning-note"><KeyRound size={14} />{t('fileContainsSecret')}</p></Card></div></div>; }

function LogsView({ notify }: { notify: Notify }) { const { t, locale } = useI18n(); const [settings, setSettings] = useState<GatewaySettings | null>(null); const [logs, setLogs] = useState<RequestLog[]>([]); const [summary, setSummary] = useState<RequestLogSummary>({ totalRequests: 0, successCount: 0, failureCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheEligibleInputTokens: 0, cachedTokens: 0, estimatedCosts: [], averageLatencyMs: null, lastRequestAt: null }); const [loading, setLoading] = useState(true); const [query, setQuery] = useState(''); const [status, setStatus] = useState<'all' | 'success' | 'failed'>('all'); const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:4312/v1'); const [enabled, setEnabled] = useState(true); const [key, setKey] = useState(''); const [saving, setSaving] = useState(false); const load = useCallback(async () => { setLoading(true); try { const result = await gatewayApi.logs({ query, status, limit: 100 }); setSettings(result.settings); setLogs(result.logs); setSummary(result.summary); if (result.settings) { setBaseUrl(result.settings.baseUrl); setEnabled(result.settings.enabled); } } catch (error) { notify(apiError(error, t), 'error'); } finally { setLoading(false); } }, [notify, query, status, t]); useEffect(() => { void load(); }, [load]); const save = async () => { setSaving(true); try { const result = await gatewayApi.saveSettings({ baseUrl, enabled }); setSettings(result.settings); if (result.apiKey) setKey(result.apiKey); notify(t('localApiSaved')); } catch (error) { notify(apiError(error, t), 'error'); } finally { setSaving(false); } }; const rotate = async () => { if (!window.confirm(t('rotateKeyTitle'))) return; setSaving(true); try { const result = await gatewayApi.rotateKey(); setSettings(result.settings); setKey(result.apiKey ?? ''); } catch (error) { notify(apiError(error, t), 'error'); } finally { setSaving(false); } }; return <div className="view"><PageIntro title={t('requestLogTitle')} subtitle={t('requestLogSubtitle')} actions={<Button variant="secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={16} />{t('refreshLogs')}</Button>} /><Card className="gateway-card"><div className="surface-head"><div><h3><Server size={17} />{t('localApiTitle')}</h3><p>{settings ? settings.baseUrl : t('setupRequired')}</p></div><span className={`api-status ${enabled ? 'on' : 'off'}`}><i />{enabled ? t('localApiRunning') : t('localApiStopped')}</span></div><div className="gateway-form"><label>{t('localApiAddress')}<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://127.0.0.1:4312/v1" /></label><label className="check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{t('enableLocalApi')}</label><div className="gateway-actions"><Button onClick={() => void save()} disabled={saving}>{saving ? <Spinner /> : <Save size={16} />}{t('saveSettings')}</Button>{settings && <Button variant="secondary" onClick={() => void rotate()} disabled={saving}><RotateCw size={16} />{t('rotateKey')}</Button>}</div></div>{key && <div className="key-reveal"><code>{key}</code><Button variant="plain" onClick={() => void navigator.clipboard.writeText(key).then(() => notify(t('keyCopied')))}><Copy size={15} />{t('copyKey')}</Button></div>}</Card><div className="stat-grid three"><Stat icon={<Activity />} label={t('totalRequests')} value={formatNumber(summary.totalRequests, locale)} /><Stat icon={<CheckCircle2 />} label={t('successRequests')} value={formatNumber(summary.successCount, locale)} /><Stat icon={<Code2 />} label={t('totalTokens')} value={formatNumber(summary.totalTokens, locale)} /></div><Card><div className="toolbar"><div className="search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('searchPlaceholder')} /></div><div className="filters">{(['all', 'success', 'failed'] as const).map((item) => <button className={status === item ? 'active' : ''} key={item} onClick={() => setStatus(item)}>{item === 'all' ? t('allFiles') : item === 'success' ? t('success') : t('failed')}</button>)}</div></div>{loading ? <div className="loading"><Spinner />{t('loading')}</div> : logs.length ? <div className="table-wrap cp-sidebar-scrollbar"><table><thead><tr><th>{t('requestTime')}</th><th>{t('requestPath')}</th><th>{t('account')}</th><th>{t('response')}</th><th>{t('tokens')}</th><th>{t('latency')}</th></tr></thead><tbody>{logs.map((log) => <tr key={log.id}><td>{formatDate(log.timestampMs, locale)}<small>{log.requestId?.slice(0, 12) ?? ''}</small></td><td><code>{log.method ?? 'API'} {log.path ?? '—'}</code></td><td>{log.accountSnapshot ?? '—'}</td><td><span className={`status ${log.failed ? 'bad' : 'good'}`}><i />{log.failed ? (log.failStatusCode ?? t('failed')) : t('success')}</span></td><td>{formatNumber(log.totalTokens, locale)}</td><td>{log.latencyMs === null ? '—' : `${log.latencyMs} ms`}</td></tr>)}</tbody></table></div> : <Empty icon={List} title={t('noLogs')} body={t('noLogsBody')} />}</Card></div>; }

function Dialog({ title, children, layerClassName = '', onClose }: { title: string; children: ReactNode; layerClassName?: string; onClose: () => void }) { return <div className={`dialog-layer${layerClassName ? ` ${layerClassName}` : ''}`} role="dialog" aria-modal="true"><button className="dialog-backdrop" aria-label={title} onClick={onClose} /><div className="dialog"><button className="dialog-close" onClick={onClose} aria-label={title}><X size={18} /></button><h3>{title}</h3>{children}</div></div>; }
