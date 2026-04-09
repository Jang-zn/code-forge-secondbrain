import * as fs from 'fs';
import type { ParsedMessage, ParsedSession, RawRecord, RawContentBlock, RawUserRecord, RawAssistantRecord, ToolCallDigest } from './types';

interface PendingCall {
  messageIdx: number;
  callIdx: number;
}

// Internal extension to carry tool_use id during parsing (stripped before return)
interface InternalToolCall extends ToolCallDigest {
  _id?: string;
}

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

    let sessionId = '';
    let projectPath = '';
    let gitBranch: string | undefined;
    let slug: string | undefined;
    let firstTimestamp = '';
    let lastTimestamp = '';

    const messages: ParsedMessage[] = [];
    const toolUsesSet = new Set<string>();
    // Maps tool_use_id → position in messages array for result linking
    const pendingToolCalls = new Map<string, PendingCall>();

    for (const record of records) {
      if (record.type === 'file-history-snapshot' || record.type === 'progress' || record.type === 'system') {
        continue;
      }

      const r = record as RawUserRecord | RawAssistantRecord;

      if (!sessionId && r.sessionId) {
        sessionId = r.sessionId;
        projectPath = r.cwd ?? '';
        gitBranch = r.gitBranch;
        slug = (r as any).slug;
        firstTimestamp = r.timestamp;
      }
      if (r.timestamp) {
        lastTimestamp = r.timestamp;
      }

      if (record.type === 'assistant') {
        const ar = record as RawAssistantRecord;
        const { text, tools, toolCalls } = extractAssistantContent(ar.message.content);
        for (const t of tools) toolUsesSet.add(t);

        if (text || toolCalls.length > 0) {
          const msgIdx = messages.length;
          // Strip internal _id before storing
          const publicCalls: ToolCallDigest[] = toolCalls.map(({ _id, ...rest }) => rest);
          messages.push({
            role: 'assistant',
            content: text,
            timestamp: r.timestamp,
            uuid: ar.uuid,
            toolCalls: publicCalls.length > 0 ? publicCalls : undefined,
          });
          // Register tool call IDs for cross-message result linking
          for (let i = 0; i < toolCalls.length; i++) {
            if (toolCalls[i]._id) {
              pendingToolCalls.set(toolCalls[i]._id!, { messageIdx: msgIdx, callIdx: i });
            }
          }
        }
      } else if (record.type === 'user') {
        const ur = record as RawUserRecord;
        if (ur.isMeta) continue;

        const text = extractUserText(ur.message.content, pendingToolCalls, messages);
        if (text) {
          messages.push({ role: 'user', content: text, timestamp: r.timestamp, uuid: ur.uuid });
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

function extractAssistantContent(content: RawContentBlock[]): { text: string; tools: string[]; toolCalls: InternalToolCall[] } {
  const parts: string[] = [];
  const tools: string[] = [];
  const toolCalls: InternalToolCall[] = [];
  let hasNonThinking = false;

  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text);
      hasNonThinking = true;
    } else if (block.type === 'tool_use') {
      tools.push(block.name);
      hasNonThinking = true;
      const inputDigest = buildInputDigest(block.name, block.input);
      if (inputDigest) {
        toolCalls.push({ name: block.name, inputDigest, _id: block.id });
      }
    }
    // Skip 'thinking' blocks
  }

  if (!hasNonThinking) return { text: '', tools: [], toolCalls: [] };

  return { text: parts.join('\n').trim(), tools, toolCalls };
}

function extractUserText(
  content: string | RawContentBlock[],
  pendingToolCalls: Map<string, PendingCall>,
  messages: ParsedMessage[],
): string {
  if (typeof content === 'string') return content.trim();

  const parts: string[] = [];

  for (const block of content) {
    if (block.type === 'text') {
      if (block.text.startsWith('<teammate-message')) continue;
      parts.push(block.text);
    } else if (block.type === 'tool_result') {
      // Link result back to the pending assistant toolCall
      const pending = pendingToolCalls.get(block.tool_use_id);
      if (pending) {
        const msg = messages[pending.messageIdx];
        if (msg?.toolCalls?.[pending.callIdx]) {
          const rawContent = typeof block.content === 'string'
            ? block.content
            : (block.content as RawContentBlock[]).flatMap(b => b.type === 'text' ? [(b as any).text] : []).join('\n');
          msg.toolCalls[pending.callIdx].resultDigest = buildResultDigest(rawContent, block.is_error === true);
          msg.toolCalls[pending.callIdx].isError = block.is_error === true;
        }
        pendingToolCalls.delete(block.tool_use_id);
      }
      // Do NOT push tool_result content to user text
    }
  }

  return parts.join('\n').trim();
}

function buildInputDigest(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const inp = input as Record<string, unknown>;

  switch (toolName) {
    case 'Edit':
    case 'str_replace_editor':
    case 'MultiEdit': {
      const p = String(inp.file_path ?? inp.path ?? '');
      return p ? `file=${p}` : '';
    }
    case 'Write':
    case 'NotebookEdit': {
      const p = String(inp.file_path ?? inp.path ?? '');
      return p ? `file=${p}` : '';
    }
    case 'Bash':
    case 'bash': {
      const cmd = String(inp.command ?? inp.cmd ?? '').slice(0, 200);
      return cmd ? `cmd=${cmd}` : '';
    }
    case 'Read': {
      const p = String(inp.file_path ?? inp.path ?? '');
      return p ? `file=${p}` : '';
    }
    case 'Glob':
    case 'Grep': {
      const pattern = String(inp.pattern ?? inp.glob ?? '');
      const dir = String(inp.path ?? inp.dir ?? '');
      return [pattern && `pattern=${pattern}`, dir && `path=${dir}`].filter(Boolean).join(' ');
    }
    case 'WebFetch':
    case 'WebSearch': {
      const q = String(inp.url ?? inp.query ?? '').slice(0, 100);
      return q ? `query=${q}` : '';
    }
    default:
      return '';
  }
}

function buildResultDigest(content: string, isError: boolean): string {
  const cleaned = content.trim();
  if (!cleaned) return '';

  if (isError) {
    // Always show first 200 chars of errors
    return cleaned.slice(0, 200);
  }

  const MAX = 160;
  if (cleaned.length <= MAX) return cleaned;

  // head + tail digest
  return `${cleaned.slice(0, 80)}…[${cleaned.length}자]…${cleaned.slice(-80)}`;
}
