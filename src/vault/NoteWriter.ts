import * as fs from 'fs';
import * as path from 'path';
import type { SummaryResult } from '../summarizer/GeminiSummarizer';
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

const MAX_MESSAGE_CHARS = 800;

export class NoteWriter {
  write(opts: NoteWriteOptions): string {
    const { vaultPath, targetFolder, projectName, session, summary, matchedLinks } = opts;

    const date = session.firstTimestamp.slice(0, 10); // YYYY-MM-DD
    const safeTitle = slugify(summary.title);
    const sessionSuffix = session.sessionId.slice(0, 8);

    // Resolve potential filename conflict
    const dir = path.join(vaultPath, targetFolder, projectName);
    fs.mkdirSync(dir, { recursive: true });

    const baseName = `${date}-${safeTitle}`;
    let fileName = `${baseName}.md`;
    if (!opts.existingNotePath && fs.existsSync(path.join(dir, fileName))) {
      fileName = `${baseName}-${sessionSuffix}.md`;
    }

    const notePath = opts.existingNotePath ?? path.join(dir, fileName);

    const content = this.renderNote(opts, date);
    fs.writeFileSync(notePath, content, 'utf-8');

    return notePath;
  }

  private renderNote(opts: NoteWriteOptions, date: string): string {
    const { projectName, session, summary, matchedLinks } = opts;
    const tags = ['claude', projectName.toLowerCase(), ...summary.tags].map(t =>
      t.replace(/\s+/g, '-').toLowerCase()
    );

    const frontmatter = [
      '---',
      `title: "${escapeYaml(summary.title)}"`,
      `date: ${date}`,
      `tags: [${tags.join(', ')}]`,
      `project: ${projectName}`,
      `session_id: ${session.sessionId}`,
      session.gitBranch ? `git_branch: ${session.gitBranch}` : null,
      '---',
    ]
      .filter(Boolean)
      .join('\n');

    // Key Topics section with wikilinks
    const keyTopicsSection = summary.keyTopics.length > 0
      ? summary.keyTopics.map(topic => {
          const link = matchedLinks.find(l => l.toLowerCase() === topic.toLowerCase());
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

    // Full conversation (truncated messages)
    const conversationLines = session.messages.map(m => {
      const role = m.role === 'user' ? '**User**' : '**Claude**';
      const content = m.content.length > MAX_MESSAGE_CHARS
        ? m.content.slice(0, MAX_MESSAGE_CHARS) + '…'
        : m.content;
      return `> ${role}: ${content.replace(/\n/g, '\n> ')}`;
    });

    return [
      frontmatter,
      '',
      `# ${summary.title}`,
      '',
      '## Summary',
      summary.summary,
      '',
      '## Key Topics',
      keyTopicsSection,
      '',
      '## Decisions',
      decisionsSection,
      '',
      '## Code Changes',
      codeChangesSection,
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
