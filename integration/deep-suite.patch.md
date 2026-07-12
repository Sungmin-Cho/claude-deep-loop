# deep-suite marketplace 등록 패치 플랜 — deep-loop

> **상태: 배포·동기화 미승인 (patch-only).** push, PR, merge, publish, delete와 marketplace/deep-suite sync는 모두 proposal-only이며 **각 단계별 사용자 명시 승인 필수**다.
> SHA 핀닝 제약: `check-pinned-plugin-paths.js`가 `gh api`로 레포를 SHA에서 fetch해 경로를 검증하므로 **push 전엔 `npm run preflight` 불가**.
> 따라서 이 문서는 **post-merge sync에 별도 승인**을 받은 경우에만 적용할 정확한 3-파일 lockstep diff를 기록한다. `<SHA>`는 승인된 push/merge 후 회수한 40-char 커밋 해시로 치환한다. 이 문서의 존재는 release 또는 sync 완료 증거가 아니다.

## 적용 순서 (사용자 push 승인 시)

1. 적용 직전 deep-loop 커밋에서 `npm run preflight`를 다시 실행해 validate와 전체 테스트가 통과하는지 확인한다. 고정 테스트 개수는 기록하지 않는다.
2. GitHub push (**사용자 승인 필수**): `git push origin <branch>` → `https://github.com/Sungmin-Cho/claude-deep-loop.git`.
3. 별도 승인된 PR/merge 뒤 merged `main`의 40-char SHA를 회수한다.
4. **별도 post-merge sync 승인** 후 deep-suite 레포에서 아래 3개 파일을 lockstep 수정한다.
5. deep-suite `npm run preflight`를 실행한다(README 테이블 자동재생성 — 마커 내부 수동 수정 금지).

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
  "runtime": ["node"],
  "capabilities": ["orchestration", "loop-state", "durable-state", "handoff", "respawn", "cross-plugin-routing", "budget-breaker-gates"],
  "artifacts": {
    "writes": [
      ".deep-loop/runs/<run-id>/loop.json",
      ".deep-loop/runs/<run-id>/event-log.jsonl",
      ".deep-loop/runs/<run-id>/handoffs/<ts>-next-session.md",
      ".deep-loop/runs/<run-id>/reviews/<sha256>.json",
      ".deep-loop/runs/<run-id>/preflight/cache/<cache-key>.json",
      ".deep-loop/runs/<run-id>/preflight/accounting/<cache-key>.json",
      ".deep-loop/runs/<run-id>/preflight/process-receipts/<receipt>.json",
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
`check-pinned-plugin-paths.js`는 위 `artifacts.writes`/`reads`의 distinctive static segment(`.deep-loop/runs`, `loop.json`, `event-log.jsonl`, `handoffs`, `reviews`, `preflight/cache`, `preflight/accounting`, `preflight/process-receipts`, `final-report.md`)가 pinned SHA의 deep-loop 소스(hooks/skills/scripts)에 실제로 등장하는지 검증한다. Node-only runtime은 Bash wrapper가 제거된 현재 hook/control-plane 계약을 반영한다.

---

## 미승인 시

이 문서만 남기고 등록·배포·동기화를 보류한다. Marketplace sync는 proposal-only이고 별도 승인 없이는 실행하지 않는다. 등록은 **발견성만 추가**하며 deep-loop의 standalone 동작에 대한 의존성이 아니다.
