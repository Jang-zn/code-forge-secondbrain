import * as fs from 'fs';
import * as path from 'path';
import type { SummaryResult } from '../summarizer/types';
import type { ParsedSession } from '../parser/types';

export interface NoteWriteOptions {
  vaultPath: string;
  targetFolder: string;
  projectName: string;
  session: ParsedSession;
  summary: SummaryResult;
  matchedLinks: string[];
  existingNotePath?: string;
}

export class NoteWriter {
  write(opts: NoteWriteOptions): string {
    const { vaultPath, targetFolder, projectName, session, summary, matchedLinks } = opts;

    const dateStr = formatDate(session.firstTimestamp);
    const timeStr = formatTime(session.firstTimestamp);
    const safeTitle = slugify(summary.title);

    const dir = path.join(vaultPath, targetFolder, projectName, dateStr);
    fs.mkdirSync(dir, { recursive: true });

    const typeTag = (summary.tags[0] ?? 'log').toLowerCase();
    const baseName = `${timeStr}-[${typeTag}]-${safeTitle}`;
    const content = this.renderNote(opts, `${dateStr} ${timeStr}`);

    if (opts.existingNotePath) {
      fs.writeFileSync(opts.existingNotePath, content, 'utf-8');
      return opts.existingNotePath;
    }

    const primaryPath = path.join(dir, `${baseName}.md`);
    try {
      const fd = fs.openSync(primaryPath, 'wx');
      fs.writeFileSync(fd, content, 'utf-8');
      fs.closeSync(fd);
      return primaryPath;
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
    }
    // Collision: try suffix variants to avoid silently losing data
    for (let i = 2; i <= 10; i++) {
      const altPath = path.join(dir, `${baseName}-${i}.md`);
      try {
        const fd2 = fs.openSync(altPath, 'wx');
        fs.writeFileSync(fd2, content, 'utf-8');
        fs.closeSync(fd2);
        return altPath;
      } catch (e2: any) {
        if (e2.code !== 'EEXIST') throw e2;
      }
    }
    // All suffixes taken — overwrite the primary path as last resort
    fs.writeFileSync(primaryPath, content, 'utf-8');
    return primaryPath;
  }

  private renderNote(opts: NoteWriteOptions, datetime: string): string {
    const { projectName, session, summary, matchedLinks } = opts;
    const tags = ['claude', projectName.toLowerCase(), ...summary.tags].map(t =>
      t.replace(/\s+/g, '-').toLowerCase()
    );

    const frontmatter = [
      '---',
      `title: "${escapeYaml(summary.title)}"`,
      `date: ${datetime}`,
      `tags: [${tags.join(', ')}]`,
      `project: ${projectName}`,
      `session_id: ${session.sessionId}`,
      session.gitBranch ? `git_branch: ${session.gitBranch}` : null,
      '---',
    ]
      .filter(Boolean)
      .join('\n');

    // Investigation section
    const investigationSection = summary.investigation
      ? formatNarrative(summary.investigation)
      : '_없음_';

    // Decision rationale section
    const decisionRationaleSection = summary.decisionRationale
      ? formatNarrative(summary.decisionRationale)
      : '_없음_';

    // Insights section
    const insightsSection = summary.insights.length > 0
      ? summary.insights.map(i => `- ${i}`).join('\n')
      : '_없음_';

    // Key Topics section with wikilinks
    const keyTopicsSection = summary.keyTopics.length > 0
      ? summary.keyTopics.map(topic => {
          const link = matchedLinks.find(l =>
            l.toLowerCase().includes(topic.toLowerCase()) ||
            topic.toLowerCase().includes(l.toLowerCase())
          );
          return link ? `- [[${link}]] - ${topic}` : `- ${topic}`;
        }).join('\n')
      : '_없음_';

    // Decisions section
    const decisionsSection = summary.decisions.length > 0
      ? summary.decisions.map(d => `- ${d}`).join('\n')
      : '_없음_';

    // Code changes section
    const codeChangesSection = summary.codeChanges.length > 0
      ? summary.codeChanges.map(c => `- ${c}`).join('\n')
      : '_없음_';

    // Related notes from matched links
    const relatedSection = matchedLinks.length > 0
      ? matchedLinks.map(l => `- [[${l}]]`).join('\n')
      : '_없음_';

    // Full conversation — filtered to indices assigned by summarizer
    const indexSet = new Set(summary.messageIndices);
    const filteredMessages = summary.messageIndices.length > 0
      ? session.messages.filter((_, i) => indexSet.has(i))
      : session.messages;
    const conversationLines = filteredMessages.map(m => {
      const role = m.role === 'user' ? '**User**' : '**Claude**';
      return `> ${role}: ${m.content.replace(/\r?\n/g, '\n> ')}`;
    });

    return [
      frontmatter,
      '',
      `# ${summary.title}`,
      '',
      '## Summary',
      formatNarrative(summary.summary),
      '',
      '## Investigation',
      investigationSection,
      '',
      '## Key Topics',
      keyTopicsSection,
      '',
      '## Decisions',
      decisionsSection,
      '',
      '## Decision Rationale',
      decisionRationaleSection,
      '',
      '## Code Changes',
      codeChangesSection,
      '',
      '## Insights',
      insightsSection,
      '',
      '## Related Notes',
      relatedSection,
      '',
      '## Full Conversation',
      conversationLines.join('\n\n'),
      '',
    ].join('\n');
  }
}

function formatDate(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatTime(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${hh}-${min}`;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

function escapeYaml(str: string): string {
  return str.replace(/"/g, '\\"');
}

// 이미 줄바꿈이 있으면 그대로, 없으면 문장 단위로 줄바꿈 삽입
function formatNarrative(text: string): string {
  if (!text) return text;
  if (text.includes('\n\n')) return text;

  // 문장 끝(. ! ?) 뒤에 공백이 오는 패턴을 기준으로 분리
  const sentences = text.match(/[^.!?]+[.!?]+[\s]*/g) ?? [text];
  const chunkSize = 3;
  const chunks: string[] = [];
  for (let i = 0; i < sentences.length; i += chunkSize) {
    chunks.push(sentences.slice(i, i + chunkSize).join('').trimEnd());
  }
  return chunks.join('\n\n');
}
