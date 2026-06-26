-- 회고 lesson의 출처(source)를 구분한다: 'manual'(사람 승인) | 'auto'(고신뢰 자동 적용).
-- 고신뢰(Succeeded) run은 사람 게이트 없이 바로 active로 적용되고, 회귀 안전장치는
-- 'auto' lesson만 비활성화한다 — 사람이 승인한 경험칙은 자동 롤백 대상에서 제외한다.
-- 기존 row는 모두 'manual'로 본다(사람 승인 게이트만 거쳤던 데이터).
ALTER TABLE role_retrospectives
  ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto'));
