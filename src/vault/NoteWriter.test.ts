import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NoteWriter } from './NoteWriter';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ParsedSession } from '../parser/types';
import type { SummaryResult } from '../summarizer/types';

let tmpVault: string;

beforeEach(() => {
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'notewriter-test-'));
});

afterEach(() => {
  fs.rmSync(tmpVault, { recursive: true, force: true });
});

function makeSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    sessionId: 'sess-001',
    projectPath: '/Users/jang/projects/my-app',
    gitBranch: undefined,
    slug: undefined,
    firstTimestamp: '2024-06-15T10:30:00Z',
    lastTimestamp: '2024-06-15T11:00:00Z',
    messages: [
      { role: 'user', content: 'Hello', timestamp: '2024-06-15T10:30:00Z', uuid: 'u1' },
      { role: 'assistant', content: 'Hi there', timestamp: '2024-06-15T10:31:00Z', uuid: 'a1' },
    ],
    toolUses: [],
    filePath: '/tmp/test.jsonl',
    mtime: 0,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<SummaryResult> = {}): SummaryResult {
  return {
    title: 'Test Topic',
    summary: 'A brief summary of the conversation.',
    keyTopics: ['TypeScript', 'Testing'],
    decisions: ['Use vitest for testing'],
    codeChanges: [],
    tags: ['implementation', 'test'],
    messageIndices: [0, 1],
    incomplete: false,
    investigation: 'Investigated testing approaches.',
    decisionRationale: 'Vitest is fast and compatible.',
    insights: ['Mocking is important for isolation'],
    ...overrides,
  };
}

describe('NoteWriter', () => {
  const writer = new NoteWriter();

  // 1. Normal write: creates dir and file, returns correct path ending in .md
  it('정상 쓰기: 디렉토리와 파일을 생성하고 .md로 끝나는 경로를 반환한다', () => {
    const session = makeSession();
    const summary = makeSummary();
    const notePath = writer.write({
      vaultPath: tmpVault,
      targetFolder: 'Notes',
      projectName: 'my-app',
      session,
      summary,
      matchedLinks: [],
    });

    expect(notePath.endsWith('.md')).toBe(true);
    expect(fs.existsSync(notePath)).toBe(true);
    // Dir structure: vault/Notes/my-app/2024-06-15/
    expect(notePath).toContain(path.join('Notes', 'my-app', '2024-06-15'));
  });

  // 2. File content has correct frontmatter
  it('파일 내용에 올바른 프론트매터(title, date, tags, project, session_id)가 포함된다', () => {
    const session = makeSession();
    const summary = makeSummary();
    const notePath = writer.write({
      vaultPath: tmpVault,
      targetFolder: 'Notes',
      projectName: 'my-app',
      session,
      summary,
      matchedLinks: [],
    });

    const content = fs.readFileSync(notePath, 'utf-8');
    expect(content).toContain('title: "Test Topic"');
    expect(content).toContain('date: 2024-06-15');
    expect(content).toContain('project: my-app');
    expect(content).toContain('session_id: sess-001');
    expect(content).toContain('tags:');
  });

  // 3. existingNotePath: overwrites that file, returns same path
  it('existingNotePath 제공 시 해당 파일을 덮어쓰고 같은 경로를 반환한다', () => {
    const existingPath = path.join(tmpVault, 'existing-note.md');
    fs.writeFileSync(existingPath, 'old content', 'utf-8');

    const session = makeSession();
    const summary = makeSummary({ title: 'Updated Topic' });
    const notePath = writer.write({
      vaultPath: tmpVault,
      targetFolder: 'Notes',
      projectName: 'my-app',
      session,
      summary,
      matchedLinks: [],
      existingNotePath: existingPath,
    });

    expect(notePath).toBe(existingPath);
    const content = fs.readFileSync(existingPath, 'utf-8');
    expect(content).toContain('Updated Topic');
    expect(content).not.toContain('old content');
  });

  // 4. EEXIST collision: primary path already exists → returns path with -2 suffix
  it('EEXIST 충돌: 동일 경로 파일 존재 시 -2 접미사 경로로 저장한다', () => {
    const session = makeSession();
    const summary = makeSummary();

    // Write first note
    const firstPath = writer.write({
      vaultPath: tmpVault,
      targetFolder: 'Notes',
      projectName: 'my-app',
      session,
      summary,
      matchedLinks: [],
    });
    expect(fs.existsSync(firstPath)).toBe(true);

    // Write second note with same title/time → collision
    const secondPath = writer.write({
      vaultPath: tmpVault,
      targetFolder: 'Notes',
      projectName: 'my-app',
      session,
      summary,
      matchedLinks: [],
    });

    expect(secondPath).not.toBe(firstPath);
    expect(secondPath).toContain('-2');
    expect(secondPath.endsWith('.md')).toBe(true);
    expect(fs.existsSync(secondPath)).toBe(true);

    const content = fs.readFileSync(secondPath, 'utf-8');
    expect(content).toContain('Test Topic');
  });

  // 5. Multiple collisions: primary + -2 → gets -3
  it('복수 충돌: 기본과 -2 파일 존재 시 -3 접미사를 사용한다', () => {
    const session = makeSession();
    const summary = makeSummary();
    const opts = {
      vaultPath: tmpVault,
      targetFolder: 'Notes',
      projectName: 'my-app',
      session,
      summary,
      matchedLinks: [],
    };

    const first = writer.write(opts);
    const second = writer.write(opts);
    const third = writer.write(opts);

    expect(first).not.toContain('-2');
    expect(second).toContain('-2');
    expect(third).toContain('-3');
    expect(fs.existsSync(third)).toBe(true);
  });

  // 6. Tags include project name and summary tags
  it('태그에 프로젝트명과 요약 태그가 포함된다', () => {
    const session = makeSession();
    const summary = makeSummary({ tags: ['bug-fix', 'refactor'] });
    const notePath = writer.write({
      vaultPath: tmpVault,
      targetFolder: 'Notes',
      projectName: 'my-app',
      session,
      summary,
      matchedLinks: [],
    });

    const content = fs.readFileSync(notePath, 'utf-8');
    expect(content).toContain('claude');
    expect(content).toContain('my-app');
    expect(content).toContain('bug-fix');
    expect(content).toContain('refactor');
  });

  // 7. matchedLinks creates wikilinks in Key Topics section
  it('matchedLinks: Key Topics 섹션에 위키링크가 생성된다', () => {
    const session = makeSession();
    const summary = makeSummary({ keyTopics: ['TypeScript', 'Testing Framework'] });
    const notePath = writer.write({
      vaultPath: tmpVault,
      targetFolder: 'Notes',
      projectName: 'my-app',
      session,
      summary,
      matchedLinks: ['TypeScript'],
    });

    const content = fs.readFileSync(notePath, 'utf-8');
    expect(content).toContain('[[TypeScript]]');
  });

  // 8. Empty matchedLinks: topics shown without wikilinks
  it('matchedLinks 빈 배열: 위키링크 없이 토픽이 표시된다', () => {
    const session = makeSession();
    const summary = makeSummary({ keyTopics: ['TypeScript', 'Testing'] });
    const notePath = writer.write({
      vaultPath: tmpVault,
      targetFolder: 'Notes',
      projectName: 'my-app',
      session,
      summary,
      matchedLinks: [],
    });

    const content = fs.readFileSync(notePath, 'utf-8');
    expect(content).toContain('- TypeScript');
    expect(content).toContain('- Testing');
    expect(content).not.toContain('[[TypeScript]]');
  });

  // 9. gitBranch in frontmatter when present
  it('gitBranch가 있으면 프론트매터에 git_branch가 포함된다', () => {
    const session = makeSession({ gitBranch: 'feature/my-feature' });
    const summary = makeSummary();
    const notePath = writer.write({
      vaultPath: tmpVault,
      targetFolder: 'Notes',
      projectName: 'my-app',
      session,
      summary,
      matchedLinks: [],
    });

    const content = fs.readFileSync(notePath, 'utf-8');
    expect(content).toContain('git_branch: feature/my-feature');
  });

  // Bonus: gitBranch absent → no git_branch line in frontmatter
  it('gitBranch 없으면 프론트매터에 git_branch 줄이 없다', () => {
    const session = makeSession({ gitBranch: undefined });
    const summary = makeSummary();
    const notePath = writer.write({
      vaultPath: tmpVault,
      targetFolder: 'Notes',
      projectName: 'my-app',
      session,
      summary,
      matchedLinks: [],
    });

    const content = fs.readFileSync(notePath, 'utf-8');
    expect(content).not.toContain('git_branch:');
  });
});
