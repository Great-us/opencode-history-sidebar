import MarkdownIt from 'markdown-it';
import type { LogEntry } from '../shared/types';

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
// Transcript links and images stay inert: reading history never fetches a remote URL or runs a command URI.
markdown.renderer.rules.link_open = (tokens, index) => `<span class="record-link"><span class="muted">[${escapeHtml(String(tokens[index].attrGet('href') ?? ''))}] </span>`;
markdown.renderer.rules.link_close = () => '</span>';
markdown.renderer.rules.image = (tokens, index) => `<span>[图片：${escapeHtml(tokens[index].content)} · ${escapeHtml(String(tokens[index].attrGet('src') ?? ''))}]</span>`;
const labels: Record<string, string> = { user: '用户', assistant: 'OpenCode', thinking: '思考', tool: '工具', system: '系统', subagent: '子智能体' };

/** Render every loaded entry directly — no cap, no truncation; paging is cursor-driven. */
export function renderEntries(entries: readonly LogEntry[]): string {
  return entries.map(entry => {
    const body = markdown.render(entry.text);
    const header = `<header>${labels[entry.role] ?? escapeHtml(entry.role)} <time>${escapeHtml(new Date(entry.ts).toLocaleString())}</time></header>`;
    const attachments = (entry.richContent?.map(item => `<p class="muted">附件：${escapeHtml(item.path)} (${escapeHtml(item.mediaType)})</p>`).join('') ?? '') +
      (entry.outputRef ? `<p class="muted">另有独立保存的输出（未展开）：${escapeHtml(entry.outputRef)}</p>` : '');
    return entry.role === 'thinking' || entry.role === 'tool'
      ? `<details class="entry ${entry.role}" open><summary>${labels[entry.role]}</summary>${header}${body}${attachments}</details>`
      : `<section class="entry ${entry.role}">${header}${body}${attachments}</section>`;
  }).join('');
}
