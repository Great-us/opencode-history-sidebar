/**
 * Extension-host runner for the isolated development host (harness reused
 * from the Muse sidebar, MIT; env/marker names re-namespaced).
 *
 * Revision changes: the pending-backend skip path is GONE — the backend is
 * implemented, and a missing compiled backend or a missing required check is
 * a failure, never a skipped pass. The synthetic isolation now covers every
 * service-discovery root (XDG_STATE_HOME, XDG_CACHE_HOME) on top of the home
 * roots and OPENCODE_DB/OPENCODE_CONFIG, so the host can never discover the
 * user's real shared service. The sandbox service this runner's hosts use is
 * owned by the runner and stopped after the phases complete; the user's real
 * service is never contacted or stopped.
 *
 * Requires OPENCODE_TEST_ENGINE pointing at the real native OpenCode exe
 * (absolute path); the in-host test seeds synthetic sessions exclusively
 * through the official import/create APIs — never a prompt, never a model.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createServer } = require('node:net');

(async () => {
  const root = path.resolve(__dirname, '..');
  const backendImplemented = await fs.access(path.join(root, 'out', 'src', 'backend', 'catalogService.js')).then(() => true, () => false);
  if (!backendImplemented) {
    // No skip path: the integrated phase requires the real backend.
    throw new Error('Real backend missing (out/src/backend/catalogService.js not compiled); the extension-host phase must fail, not skip.');
  }
  const box = path.join(root, '.test-sandbox', `host-${Date.now()}`);
  const home = path.join(box, 'opencode', 'home');
  const env = {
    HOME: home, USERPROFILE: home,
    XDG_DATA_HOME: path.join(box, 'opencode', 'xdg', 'data'),
    XDG_CONFIG_HOME: path.join(box, 'opencode', 'xdg', 'config'),
    XDG_STATE_HOME: path.join(box, 'opencode', 'xdg', 'state'),
    XDG_CACHE_HOME: path.join(box, 'opencode', 'xdg', 'cache'),
    APPDATA: path.join(box, 'opencode', 'appdata-roaming'),
    LOCALAPPDATA: path.join(box, 'opencode', 'appdata-local'),
    OPENCODE_DB: path.join(box, 'opencode', 'xdg', 'data', 'opencode', 'opencode.db'),
    OPENCODE_CONFIG: path.join(box, 'opencode', 'xdg', 'config', 'opencode', 'opencode.json'),
    OPENCODE_DISABLE_AUTOUPDATE: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0',
  };
  for (const key of ['HOME', 'USERPROFILE', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA']) await fs.mkdir(env[key], { recursive: true });
  const engine = process.env.OPENCODE_TEST_ENGINE;
  if (!engine || !path.isAbsolute(engine)) throw new Error('Set OPENCODE_TEST_ENGINE to the absolute native OpenCode exe path.');
  const configKeys = ['HOME', 'USERPROFILE', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA', 'OPENCODE_DB', 'OPENCODE_CONFIG'];
  const config = { enginePath: engine, env: Object.fromEntries(configKeys.map(key => [key, env[key]])), extraArgs: [] };
  const configPath = path.join(box, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  const userdata = path.join(box, 'user-data');
  const extensions = path.join(box, 'extensions');
  await fs.mkdir(path.join(userdata, 'User'), { recursive: true });
  await fs.mkdir(extensions, { recursive: true });
  await fs.writeFile(path.join(userdata, 'User', 'settings.json'), JSON.stringify({ 'chat.disableAIFeatures': true, 'terminal.integrated.enablePersistentSessions': true, 'terminal.integrated.confirmOnExit': 'never', 'security.workspace.trust.enabled': false, 'window.restoreWindows': 'none', 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'update.mode': 'none', 'extensions.autoUpdate': false }));
  const code = process.env.VSCODE_EXECUTABLE || path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe');
  const phases = (process.env.OPENCODE_HISTORY_TEST_PHASES || 'primary,persistence,reload,legacy').split(',');
  const runEngine = args => new Promise(resolvePromise => {
    const child = spawn(engine, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let output = '';
    child.stderr?.on('data', chunk => { output += String(chunk); });
    child.on('error', () => resolvePromise({ code: -1, output }));
    child.on('close', code2 => resolvePromise({ code: code2, output }));
  });
  try {
    const port = await new Promise((resolvePort, reject) => {
      const socket = createServer();
      socket.once('error', reject);
      socket.listen(0, '127.0.0.1', () => {
        const port = socket.address().port;
        socket.close(() => resolvePort(port));
      });
    });
    const configured = await runEngine(['service', 'set', 'port', String(port)]);
    if (configured.code !== 0) throw new Error(`Private dynamic service port configuration failed: ${configured.output}`);
    for (const phase of phases) {
      const runEnv = { ...process.env, ...env, OPENCODE_HISTORY_TEST_BOOTSTRAP: '1', OPENCODE_HISTORY_TEST_CONFIG: configPath, OPENCODE_HISTORY_TEST_BOX: box, OPENCODE_HISTORY_TEST_PHASE: phase, OPENCODE_HISTORY_TEST_UI_SHAKEDOWN: '1' };
      for (const key of ['ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_IPC_HOOK', 'VSCODE_CWD']) delete runEnv[key];
      const args = ['--new-window', '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--user-data-dir', userdata, '--extensions-dir', extensions, '--extensionDevelopmentPath', root, path.join(box, 'workspace')];
      await fs.mkdir(path.join(box, 'workspace'), { recursive: true });
      const child = spawn(code, args, { env: runEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let output = '';
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      await fs.writeFile(path.join(box, `${phase}-launch.log`), output);
      if (exit !== 0) throw new Error(`VS Code ${phase} failed, exit ${exit}; evidence ${box}`);
      const result = JSON.parse(await fs.readFile(path.join(box, `${phase}-result.json`), 'utf8'));
      if (!result.passed) throw new Error(`VS Code ${phase} failed: ${result.error}; evidence ${box}`);
      console.log(`VS Code ${phase}: passed`);
    }
  } finally {
    // Stop only the isolated sandbox service this runner owns (never a user service).
    const stop = await runEngine(['service', 'stop']).catch(() => ({ code: -1, output: '' }));
    console.log(`sandbox service stop exit=${stop.code}`);
    console.log(`EXTENSION_HOST_EVIDENCE=${box}`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
