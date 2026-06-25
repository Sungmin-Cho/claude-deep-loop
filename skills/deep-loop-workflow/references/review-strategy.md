# 리뷰 전략 (Review Strategy)

run 시작 시 `/deep-loop`가 리뷰 전략을 확인하는 흐름과 `review` JSON 조립 방법을 정의한다.

## 확인 질문 흐름 (§7)

### deep-review 플러그인 감지 시

기본 추천:
- reviewer: `deep-review:deep-review-loop`
- mode: `cross-model`
- flags: `["--contract", "--codex"]`

사용자 확인 후 `converge`와 `max_review_rounds`를 조정할 수 있다.

### deep-review 미감지 시

3가지 옵션 제안:
1. **codex 2-way**: Codex가 구현하고 Claude가 리뷰 (또는 반대)
2. **서브에이전트 checker**: 동일 모델의 독립 서브에이전트
3. **standalone**: 리뷰 없이 진행 (권장하지 않음 — proof 요건 충족 불가)

사용자가 확정한다.

## `review` JSON 형태

```json
{
  "points": ["design", "plan", "implementation"],
  "reviewer": "subagent-checker",
  "mode": "cross-model",
  "flags": [],
  "converge": true,
  "max_review_rounds": 5,
  "require_human_ack": false
}
```

### 필드 설명

- **points**: 리뷰할 단계 목록. 빠른 작업이면 `["implementation"]`으로 축소 가능.
- **reviewer**: 리뷰어 스킬 식별자 (`deep-review:deep-review-loop` 또는 서브에이전트 지정자).
- **mode**: `cross-model`(다른 모델) 또는 `same-model`.
- **flags**: reviewer 스킬에 전달할 추가 플래그.
- **converge**: `true`이면 APPROVE가 나올 때까지 반복(max_review_rounds 한도 내).
- **max_review_rounds**: breaker trip 전 최대 리뷰 라운드 수 (기본 5).
- **require_human_ack**: `true`이면 `/deep-loop-ack`으로만 comprehension 카운트 인정.

## 중요 사항

- 리뷰 없이 completed 전이 불가 — `finishProofState`가 독립 리뷰 proof를 요구한다.
- checker 없이 maker `done`만으로는 workstream을 `ready`로 전이할 수 없다.
- `require_human_ack=true`이면 deep-review APPROVE만으로는 comprehension debt가 줄지 않는다.
