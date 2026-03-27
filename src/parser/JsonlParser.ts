import * as fs from 'fs';
import * as path from 'path';
import type { ParsedSession, ParsedMessage, RawRecord, RawContentBlock, RawUserRecord, RawAssistantRecord } from './types';

const MAX_CHARS = 60_000;
const HEAD_EXCHANGES = 3;
const TAIL_EXCHANGES = 7;

export class JsonlParser {
  parse(filePath: string): ParsedSession | null {
    const stat = fs.statSync(filePath);
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());

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
          messages.push({ role: 'user', content: text });
        }
      } else if (record.type === 'assistant') {
        const ar = record as RawAssistantRecord;
        const { text, tools } = extractAssistantContent(ar.message.content);
        for (const t of tools) toolUsesSet.add(t);
        if (text) {
          messages.push({ role: 'assistant', content: text });
        }
      }
    }

    if (!sessionId) return null;

    // Truncate if too long
    const trimmedMessages = truncateMessages(messages);

    return {
      sessionId,
      projectPath,
      gitBranch,
      slug,
      firstTimestamp,
      lastTimestamp,
      messages: trimmedMessages,
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

function truncateMessages(messages: ParsedMessage[]): ParsedMessage[] {
  // Check total length
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars <= MAX_CHARS) return messages;

  // Keep first HEAD and last TAIL exchanges (user+assistant pair = 1 exchange)
  const exchanges: ParsedMessage[][] = [];
  let i = 0;
  while (i < messages.length) {
    const exchange: ParsedMessage[] = [];
    if (messages[i]?.role === 'user') exchange.push(messages[i++]);
    if (messages[i]?.role === 'assistant') exchange.push(messages[i++]);
    if (exchange.length > 0) exchanges.push(exchange);
  }

  const head = exchanges.slice(0, HEAD_EXCHANGES).flat();
  const tail = exchanges.slice(-TAIL_EXCHANGES).flat();

  const separator: ParsedMessage = {
    role: 'user',
    content: `[... ${exchanges.length - HEAD_EXCHANGES - TAIL_EXCHANGES} exchanges omitted ...]`,
  };

  return [...head, separator, ...tail];
}
