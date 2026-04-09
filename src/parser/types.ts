export interface ToolCallDigest {
  name: string;
  inputDigest: string;
  resultDigest?: string;
  isError?: boolean;
}

export interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  uuid?: string;
  toolCalls?: ToolCallDigest[];
}

export interface ParsedSession {
  sessionId: string;
  projectPath: string;
  gitBranch: string | undefined;
  slug: string | undefined;
  firstTimestamp: string;
  lastTimestamp: string;
  messages: ParsedMessage[];
  toolUses: string[];
  filePath: string;
  mtime: number;
}

// Raw JSONL record shapes
export interface RawUserRecord {
  type: 'user';
  uuid: string;
  timestamp: string;
  sessionId: string;
  cwd: string;
  gitBranch?: string;
  isMeta?: boolean;
  message: {
    role: 'user';
    content: string | RawContentBlock[];
  };
}

export interface RawAssistantRecord {
  type: 'assistant';
  uuid: string;
  timestamp: string;
  sessionId: string;
  cwd: string;
  gitBranch?: string;
  message: {
    role: 'assistant';
    content: RawContentBlock[];
  };
}

export type RawContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; content: string | RawContentBlock[]; is_error?: boolean; tool_use_id: string };

export type RawRecord =
  | RawUserRecord
  | RawAssistantRecord
  | { type: 'file-history-snapshot' | 'progress' | 'system'; [key: string]: unknown };
