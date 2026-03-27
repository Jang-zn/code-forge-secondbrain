# vsc-secondbrain

Claude Code 대화를 Obsidian 지식 그래프에 자동으로 저장하는 Cursor/VS Code 확장 프로그램.

`~/.claude/projects/` 폴더의 JSONL 파일을 감시하다가 대화가 끝나면 Gemini API로 요약을 생성하고, Obsidian vault에 구조화된 마크다운 노트로 저장하며 기존 문서들과 `[[wikilinks]]`로 연결합니다.

## 동작 흐름

```
~/.claude/projects/**/*.jsonl 변경 감지
  → 30분 디바운스 (세션 종료 감지 시 즉시 처리)
  → JSONL 파싱 (meta/thinking 필터링)
  → Gemini 2.5 Flash Lite로 요약 생성 (JSON 구조화, 주제별 1-3개 분리)
  → Obsidian vault 인덱싱 → [[wikilinks]] 매칭
  → vault/claude-conversations/{project}/YYYY-MM-DD/HH-MM-{title}.md 저장
  → 상태바 업데이트 + "Open Note" 알림
```

## 설치

```bash
npm install
npm run build
npx vsce package   # .vsix 생성
```

Cursor/VS Code에서 `Extensions: Install from VSIX...` → 생성된 `.vsix` 선택.

또는 개발 모드: F5 → Extension Development Host.

## 초기 설정

`Cmd+Shift+P` → `SecondBrain: Setup (Vault + API Key)` 실행.

1. Obsidian vault 루트 폴더 선택
2. Gemini API 키 입력 (OS 키체인에 저장)

끝. 이후 Claude Code 대화가 자동으로 쌓입니다.

> API 키가 없다면 [Google AI Studio](https://aistudio.google.com/apikey)에서 발급.
> 또는 환경변수 `GEMINI_API_KEY` 설정으로 대체 가능.

## 추가 설정 (선택)

`settings.json`에서 개별 항목 수정 가능:

```json
{
  "secondbrain.targetFolder": "claude-conversations",
  "secondbrain.debounceSeconds": 1800,
  "secondbrain.minMessages": 3,
  "secondbrain.summaryModel": "gemini-2.5-flash-lite"
}
```

## 커맨드

| 커맨드 | 설명 |
|---|---|
| `SecondBrain: Setup (Vault + API Key)` | **첫 실행 시** — vault 경로 + API 키 한 번에 설정 |
| `SecondBrain: Set Vault Path` | vault 경로만 재설정 |
| `SecondBrain: Set Gemini API Key` | API 키만 재설정 |
| `SecondBrain: Process Current Session` | 현재(가장 최근) 대화 즉시 처리 |
| `SecondBrain: Enable` | 자동 저장 활성화 |
| `SecondBrain: Disable` | 자동 저장 비활성화 |

## 생성되는 노트 형식

저장 경로: `vault/claude-conversations/{project}/2026-03-27/11-30-{title}.md`

```markdown
---
title: "TypeScript 파서 리팩토링"
date: 2026-03-27 11-30
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

## 다중 창 동시성

Cursor/VS Code 창을 여러 개 열어도 동일 대화에 대해 노트가 1개만 생성됩니다.

- **파일 락**: `O_EXCL` 플래그를 사용한 원자적 파일 생성 방식으로 단일 인스턴스만 처리
- **이중 검증**: 락 획득 후 state.json을 재조회하여 다른 인스턴스의 처리 완료 여부 확인
- **state.json 락**: 서로 다른 파일을 동시 처리할 때 상태 파일의 lost update 방지
- **노트 충돌 방어**: `O_EXCL` 파일 생성으로 동일 경로에 중복 쓰기 원천 차단

## 스마트 필터링

- 짧은 내부 대화(종료 명령, 단순 확인, 에이전트 내부 통신)는 문서화하지 않고 처리 완료로 마킹
- Claude Code Teams(서브에이전트) 대화는 실제 팀 소통이 아닌 자동화 도구로 올바르게 인식

## 프로젝트 구조

```
src/
├── extension.ts           # activate/deactivate + 커맨드 등록
├── config.ts              # 설정 래퍼 + SecretStorage API키 관리
├── parser/
│   ├── types.ts           # JSONL 타입 정의
│   └── JsonlParser.ts     # JSONL 파싱, thinking/meta 필터, 60k자 truncate
├── state/
│   ├── ProcessedState.ts  # ~/.vsc-secondbrain/state.json (중복 처리 방지)
│   └── FileLock.ts        # O_EXCL 기반 크로스 인스턴스 파일 락
├── summarizer/
│   └── GeminiSummarizer.ts  # Gemini 2.5 Flash Lite → 구조화된 JSON 요약
├── vault/
│   ├── VaultIndex.ts      # vault .md 파일 인덱싱
│   ├── LinkMatcher.ts     # keyTopics → [[wikilinks]] 매칭
│   └── NoteWriter.ts      # 노트 렌더링 + O_EXCL 저장
├── watcher/
│   ├── DebounceQueue.ts   # 파일별 디바운스 + concurrency:1
│   └── ClaudeWatcher.ts   # chokidar 감시 + 파이프라인 조율
└── ui/
    └── StatusBar.ts       # 상태바 (idle/processing/success/error)
```

## 엣지 케이스 처리

- **설치/업데이트 시 기존 파일**: 시작 시 전체 JSONL을 state에 pre-seed → 과거 대화 재전송 없음
- **증분 처리**: mtime + 메시지 수 추적, 이전 대화 이후 새 메시지만 Gemini 전송
- **세션 종료 감지**: 새 `.jsonl` 파일 생성 시 이전 세션 즉시 처리 (디바운스 bypass)
- **stale 락 복구**: PID 생존 확인 + 120초 타임아웃으로 죽은 프로세스의 락 자동 해제

## Windows 호환성

macOS/Linux와 동일하게 동작합니다.

- `os.homedir()` 기반 경로 처리 — `C:\Users\username\.claude\projects` 자동 인식
- chokidar glob 패턴 슬래시 정규화 (`\` → `/`)
- 경로 비교 시 대소문자 무감각 처리 (`C:\Users` vs `c:\users`)
