# vsc-secondbrain

Claude Code 대화를 Obsidian 지식 그래프에 자동으로 저장하는 Cursor/VS Code 확장 프로그램.

`~/.claude/projects/` 폴더의 JSONL 파일을 감시하다가 대화가 끝나면 Gemini API로 요약을 생성하고, Obsidian vault에 구조화된 마크다운 노트로 저장하며 기존 문서들과 `[[wikilinks]]`로 연결합니다.

## 동작 흐름

```
~/.claude/projects/**/*.jsonl 변경 감지
  → 30초 디바운스
  → JSONL 파싱 (meta/thinking 필터링)
  → Gemini API로 요약 생성 (JSON 구조화)
  → Obsidian vault 인덱싱 → [[wikilinks]] 매칭
  → vault/5.Box/claude-conversations/{project}/{date}-{title}.md 저장
  → 상태바 업데이트 + "Open Note" 알림
```

## 설치

```bash
npm install
npm run build
```

Cursor/VS Code에서 `Extensions: Install from VSIX...` → 생성된 `.vsix` 선택.

또는 개발 모드: F5 → Extension Development Host.

## 설정

`settings.json`에 추가:

```json
{
  "secondbrain.vaultPath": "/Users/yourname/obsidian-vault",
  "secondbrain.targetFolder": "5.Box/claude-conversations",
  "secondbrain.debounceSeconds": 30,
  "secondbrain.minMessages": 3,
  "secondbrain.summaryModel": "gemini-2.5-flash-lite"
}
```

## API 키 등록

커맨드 팔레트(`Cmd+Shift+P`) → `SecondBrain: Set Gemini API Key`

또는 환경변수 `GEMINI_API_KEY` 설정 (fallback).

## 커맨드

| 커맨드 | 설명 |
|---|---|
| `SecondBrain: Set Gemini API Key` | Gemini API 키를 OS 키체인에 저장 |
| `SecondBrain: Process All Existing Conversations` | 기존 JSONL 파일 일괄 처리 |
| `SecondBrain: Enable` | 자동 저장 활성화 |
| `SecondBrain: Disable` | 자동 저장 비활성화 |

## 생성되는 노트 형식

```markdown
---
title: "TypeScript 파서 리팩토링"
date: 2026-03-27
tags: [claude, vsc-secondbrain, typescript]
project: vsc-secondbrain
session_id: abc123def
git_branch: feat/parser
---

# TypeScript 파서 리팩토링

## Summary
2-3줄 요약

## Key Topics
- [[TypeScript]] - 타입 안전성 개선

## Decisions
- X 대신 Y를 사용하기로 결정

## Code Changes
- `src/parser.ts` 수정

## Related Notes
- [[기존-노트]]

## Full Conversation
> **User**: ...
> **Claude**: ...
```

## 프로젝트 구조

```
src/
├── extension.ts           # activate/deactivate + 커맨드 등록
├── config.ts              # 설정 래퍼 + SecretStorage API키 관리
├── parser/
│   ├── types.ts           # JSONL 타입 정의
│   └── JsonlParser.ts     # JSONL 파싱, thinking/meta 필터, 60k자 truncate
├── state/
│   └── ProcessedState.ts  # ~/.vsc-secondbrain/state.json (중복 처리 방지)
├── summarizer/
│   └── GeminiSummarizer.ts
├── vault/
│   ├── VaultIndex.ts      # vault .md 파일 인덱싱
│   ├── LinkMatcher.ts     # keyTopics → [[wikilinks]] 매칭
│   └── NoteWriter.ts      # 노트 렌더링 + 저장
├── watcher/
│   ├── DebounceQueue.ts   # 파일별 디바운스 + concurrency:1
│   └── ClaudeWatcher.ts   # chokidar 감시 + 파이프라인 조율
└── ui/
    └── StatusBar.ts       # 상태바
```

## 엣지 케이스 처리

- **시작 시 기존 파일**: `ignoreInitial: true`, 수동 백필은 `Process All` 커맨드
- **1MB+ JSONL**: 첫 3 + 마지막 7 exchanges 유지, 60,000자 상한
- **대화 이어서 진행**: mtime 비교로 재처리 + 노트 덮어쓰기
- **노트 제목 충돌**: `{date}-{title}-{sessionId[0:8]}.md`
