import * as fs from 'fs';
import * as path from 'path';
import type { ParsedSession, ParsedMessage, RawRecord, RawContentBlock, RawUserRecord, RawAssistantRecord } from './types';

export class JsonlParser {
  parse(filePath: string): ParsedSession | null {
    const stat = fs.statSync(filePath);
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split(/\r?\n/).filter(l => l.trim());

    const records: RawRecord[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as RawRecord);
      } catch {
        // incomplete last line — skip
      }
    }

    if (records.length === 0) return null;

    // Extract metadata from first relevant record
    let sessionId = '';
    let projectPath = '';
    let gitBranch: string | undefined;
    let slug: string | undefined;
    let firstTimestamp = '';
    let lastTimestamp = '';

    const messages: ParsedMessage[] = [];
    const toolUsesSet = new Set<string>();

    for (const record of records) {
      if (record.type === 'file-history-snapshot' || record.type === 'progress' || record.type === 'system') {
        continue;
      }

      const r = record as RawUserRecord | RawAssistantRecord;

      // Capture metadata from first qualifying record
      if (!sessionId && r.sessionId) {
        sessionId = r.sessionId;
        projectPath = r.cwd ?? '';
        gitBranch = r.gitBranch;
        // slug may appear in some records
        slug = (r as any).slug;
        firstTimestamp = r.timestamp;
      }
      if (r.timestamp) {
        lastTimestamp = r.timestamp;
      }

      if (record.type === 'user') {
        const ur = record as RawUserRecord;
        // Skip meta messages (internal /clear commands etc.)
        if (ur.isMeta) continue;

        const text = extractUserText(ur.message.content);
        if (text) {
          messages.push({ role: 'user', content: text, timestamp: r.timestamp });
        }
      } else if (record.type === 'assistant') {
        const ar = record as RawAssistantRecord;
        const { text, tools } = extractAssistantContent(ar.message.content);
        for (const t of tools) toolUsesSet.add(t);
        if (text) {
          messages.push({ role: 'assistant', content: text, timestamp: r.timestamp });
        }
      }
    }

    if (!sessionId) return null;

    return {
      sessionId,
      projectPath,
      gitBranch,
      slug,
      firstTimestamp,
      lastTimestamp,
      messages,
      toolUses: Array.from(toolUsesSet),
      filePath,
      mtime: stat.mtimeMs,
    };
  }
}

function extractUserText(content: string | RawContentBlock[]): string {
  if (typeof content === 'string') return content.trim();

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text.startsWith('<teammate-message')) continue;
      parts.push(block.text);
    }
    // Skip tool_result blocks
  }
  return parts.join('\n').trim();
}

function extractAssistantContent(content: RawContentBlock[]): { text: string; tools: string[] } {
  const parts: string[] = [];
  const tools: string[] = [];
  let hasNonThinking = false;

  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text);
      hasNonThinking = true;
    } else if (block.type === 'tool_use') {
      tools.push(block.name);
      hasNonThinking = true;
    }
    // Skip 'thinking' blocks
  }

  // If only thinking blocks, return empty (skip message)
  if (!hasNonThinking) return { text: '', tools: [] };

  return { text: parts.join('\n').trim(), tools };
}
