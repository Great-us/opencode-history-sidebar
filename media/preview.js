(() => {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState();
  if (saved) window.scrollTo(0, saved.scrollY || 0);
  document.getElementById('more')?.addEventListener('click', () => vscode.postMessage({ type: 'more' }));
  // The one explicit user step for content beyond the loaded window (tail offer).
  document.getElementById('latest')?.addEventListener('click', () => vscode.postMessage({ type: 'latest' }));
  window.addEventListener('scroll', () => vscode.setState({ scrollY: window.scrollY }));
})();
