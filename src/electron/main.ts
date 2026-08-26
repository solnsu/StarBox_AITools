import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import { startServer, type ServerRuntime } from '../server/runtime.js';
import { createDesktopTranslator } from './i18n.js';
import { ChatGptLoginService } from './chatgpt-login-service.js';

const host = '127.0.0.1';
const port = 4312;
const appUrl = `http://${host}:${port}`;
app.setName('StarBox');
app.setPath('userData', path.join(app.getPath('appData'), 'StarBox'));
const hasSingleInstanceLock = app.requestSingleInstanceLock();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let runtime: ServerRuntime | null = null;
let chatGptLoginService: ChatGptLoginService | null = null;
let quitting = false;

const iconPath = () => app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(app.getAppPath(), 'src', 'web', 'public', 'favicon.png');

const showMainWindow = () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
};

const createMainWindow = () => {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL ?? appUrl;
  const desktopRendererUrl = new URL(rendererUrl);
  desktopRendererUrl.searchParams.set('desktop', '1');
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    icon: iconPath(),
    frame: process.platform !== 'win32',
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 16, y: 15 },
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const sendMaximizedState = () => mainWindow?.webContents.send('desktop-window:maximized-change', mainWindow.isMaximized());
  mainWindow.on('maximize', sendMaximizedState);
  mainWindow.on('unmaximize', sendMaximizedState);
  mainWindow.once('ready-to-show', showMainWindow);
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== rendererUrl && !url.startsWith(`${rendererUrl}/`)) event.preventDefault();
  });
  void mainWindow.loadURL(desktopRendererUrl.toString());
};

ipcMain.on('desktop-window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
ipcMain.on('desktop-window:toggle-maximize', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  if (window.isMaximized()) window.unmaximize();
  else window.maximize();
});
ipcMain.on('desktop-window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close());
ipcMain.handle('desktop-window:is-maximized', (event) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false);

const createTray = () => {
  const t = createDesktopTranslator(app.getLocale());
  tray = new Tray(nativeImage.createFromPath(iconPath()).resize({ width: 20, height: 20 }));
  tray.setToolTip('StarBox');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('open'), click: showMainWindow },
    { type: 'separator' },
    {
      label: t('quit'),
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]));
  tray.on('double-click', showMainWindow);
};

const showStartupError = async (error: unknown) => {
  const t = createDesktopTranslator(app.getLocale());
  const code = (error as NodeJS.ErrnoException)?.code;
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error('[desktop] server startup failed', error);
  await dialog.showMessageBox({
    type: 'error',
    title: t('startupFailed'),
    message: t('startupFailed'),
    detail: code === 'EADDRINUSE' ? `${t('portInUse')}\n\n${detail}` : `${t('unknownError')}\n\n${detail}`,
  });
};

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);
  app.on('activate', () => {
    if (mainWindow) showMainWindow();
    else createMainWindow();
  });
  app.on('before-quit', (event) => {
    quitting = true;
    chatGptLoginService?.dispose();
    if (!runtime) return;
    event.preventDefault();
    const currentRuntime = runtime;
    runtime = null;
    void currentRuntime.close().finally(() => app.quit());
  });
  app.whenReady().then(async () => {
    try {
      const generatedImagesDir = path.join(app.getPath('userData'), 'generated-images');
      chatGptLoginService = new ChatGptLoginService(app.getPath('userData'));
      runtime = await startServer({
        dataDir: app.getPath('userData'),
        webDir: app.isPackaged
          ? path.join(process.resourcesPath, 'web')
          : path.join(app.getAppPath(), 'dist', 'web'),
        pricingCatalogPath: app.isPackaged
          ? path.join(process.resourcesPath, 'pricing', 'model-pricing.json')
          : path.join(app.getAppPath(), 'pricing', 'model-pricing.json'),
        port,
      }, {
        openGeneratedImagesDirectory: async () => {
          mkdirSync(generatedImagesDir, { recursive: true, mode: 0o700 });
          const error = await shell.openPath(generatedImagesDir);
          if (error) throw new Error(error);
        },
        loginWithChatGpt: () => chatGptLoginService!.login(),
        cancelChatGptLogin: () => chatGptLoginService!.cancel(),
      });
      createMainWindow();
      createTray();
    } catch (error) {
      await showStartupError(error);
      quitting = true;
      app.quit();
    }
  });
}
