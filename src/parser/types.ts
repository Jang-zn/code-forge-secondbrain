export interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ParsedSession {
  sessionId: string;
  projectPath: string;       // cwd from first record
  gitBranch: string | undefined;
  slug: string | undefined;
  firstTimestamp: string;    // ISO string
  lastTimestamp: string;     // ISO string
  messages: ParsedMessage[];
  toolUses: string[];        // distinct tool names used
  filePath: string;          // absolute path to the .jsonl file
  mtime: number;             // file mtime in ms
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
