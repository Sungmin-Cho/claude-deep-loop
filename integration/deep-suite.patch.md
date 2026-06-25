# deep-suite marketplace 등록 패치 플랜 — deep-loop

> **상태: push 미승인 (patch-only).** 비가역 외부 행동(GitHub push)은 **사용자 명시 승인 필수**(spec §13·§15).
> SHA 핀닝 제약: `check-pinned-plugin-paths.js`가 `gh api`로 레포를 SHA에서 fetch해 경로를 검증하므로 **push 전엔 `npm run preflight` 불가**.
> 따라서 이 문서는 사용자가 push를 승인했을 때 적용할 정확한 3-파일 lockstep diff를 기록한다. `<SHA>`는 push 후 회수한 40-char 커밋 해시로 치환.

## 적용 순서 (사용자 push 승인 시)

1. deep-loop 빌드·테스트·preflight 통과 확인 — **완료**: `npm run preflight` = validate + 309 tests green, 외부 의존성 0, sibling 없이 standalone 동작.
2. GitHub push (**사용자 승인 필수**): `git push origin <branch>` → `https://github.com/Sungmin-Cho/claude-deep-loop.git`.
3. 40-char SHA 회수: `git rev-parse HEAD`.
4. deep-suite 레포(`/Users/sungmin/Dev/claude-plugins/deep-suite/`)에서 아래 3개 파일을 lockstep 수정 (동일 순서·포맷).
5. deep-suite `npm run preflight` (README 테이블 자동재생성 — 마커 내부 수동 수정 ❌) PASS 확인.

---

## 1. `.claude-plugin/marketplace.json` — 엔트리 추가 (기존 plugin 배열에)

```json
{
  "name": "deep-loop",
  "description": "Loop Engineering control plane over the deep-suite — discovers work, routes to sibling deep-* plugins as maker/checker episodes, keeps durable lock-safe loop state, and hands off to fresh sessions autonomously with proof-gated terminal states and proposal-only external actions.",
  "source": {
    "source": "url",
    "url": "https://github.com/Sungmin-Cho/claude-deep-loop.git",
    "sha": "<SHA>"
  }
}
```

## 2. `.agents/plugins/marketplace.json` — 동일 엔트리 + policy + category (기존 항목과 동일 순서)

```json
{
  "name": "deep-loop",
  "description": "Loop Engineering control plane over the deep-suite — discovers work, routes to sibling deep-* plugins as maker/checker episodes, keeps durable lock-safe loop state, and hands off to fresh sessions autonomously with proof-gated terminal states and proposal-only external actions.",
  "source": {
    "source": "url",
    "url": "https://github.com/Sungmin-Cho/claude-deep-loop.git",
    "sha": "<SHA>"
  },
  "policy": {
    "installation": "AVAILABLE",
    "authentication": "ON_USE"
  },
  "category": "Coding"
}
```

## 3. `.claude-plugin/suite-extensions.json` — `plugins` 객체에 `deep-loop` 키 추가

```json
"deep-loop": {
  "runtime": ["node", "bash"],
  "capabilities": ["orchestration", "loop-state", "durable-state", "handoff", "respawn", "cross-plugin-routing", "budget-breaker-gates"],
  "artifacts": {
    "writes": [
      ".deep-loop/runs/<run-id>/loop.json",
      ".deep-loop/runs/<run-id>/event-log.jsonl",
      ".deep-loop/runs/<run-id>/handoffs/<ts>-next-session.md",
      ".deep-loop/runs/<run-id>/final-report.md",
      ".deep-loop/current"
    ],
    "reads": [
      ".deep-work/<session>/session-receipt.json",
      ".deep-review/reports/*.md",
      ".deep-docs/last-scan.json",
      ".deep-evolve/evolve-receipt.json",
      ".deep-dashboard/harnessability-report.json"
    ]
  },
  "hooks_active": ["PreCompact"]
}
```

**주의:** `hooks_active`가 비어있지 않으므로 `hooks_intentionally_empty_reason`은 불필요.
`check-pinned-plugin-paths.js`는 위 `artifacts.writes`/`reads`의 distinctive static segment(`.deep-loop/runs`, `loop.json`, `event-log.jsonl`, `final-report.md`, `handoffs`)가 pinned SHA의 deep-loop 소스(hooks/skills/scripts)에 실제로 등장하는지 검증한다 — 본 repo의 `scripts/lib/*.mjs`·`hooks/`·`skills/`에 모두 존재하므로 통과 예상.

---

## 미승인 시

이 문서만 남기고 등록 보류. 등록은 **발견성만 추가**하며 deep-loop의 standalone 동작에 대한 의존성이 아니다(요구사항 4 — 독립성).
