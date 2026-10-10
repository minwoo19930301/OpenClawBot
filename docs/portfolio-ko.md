# OpenClawBot 기반 공동 AI 작업 공간

[사용 안내](../apps/community/README.md) · [소스 구성](../README.md#구성) · [CI 구성](../.github/workflows/ci.yml)

## 프로젝트 개요

공개 Open-Grokbot 프레임워크를 바탕으로 만든 초대 기반 공동 AI 웹앱입니다. 운영자가 자신의 서버와 모델 공급자를 연결하고, 대화·브라우저·터미널·파일을 한 작업 공간에서 사용하도록 구성합니다.

- 비밀번호 해시, HttpOnly 세션, CSRF 방어, 일회성 초대와 방별 멤버 권한
- 사진·음성 업로드의 크기·MIME·파일 서명 검증과 첨부 접근 제어
- OpenClaw Gateway 또는 직접 연결한 모델 공급자, 사용자·방별 세션과 도구 실행 제한
- CDP 기반 브라우저 화면, 인증된 WebSocket 터미널, 공유 파일 탐색
- 대화 그룹·고정·보관, 사이드바 크기 조절과 분할 보기
- 대화 맥락 Fork·Compact와 실제 수집한 API 사용량 표시
- Docker Compose, HTTPS 프록시, SQLite 영속 데이터와 GitHub Actions 검증
- 선택적 PWA 설치와 VAPID 기반 Web Push 알림

**기술:** Node.js, JavaScript/TypeScript, SQLite, OpenClaw, Docker Compose, Caddy, xterm, WebSocket, Playwright/CDP. OCI ARM64용 배포 예시도 제공합니다.

## 설치와 검증 범위

서버·Cloudflare·메일·AI 등 외부 연결은 설치하는 운영자의 환경과 자격 증명으로 설정합니다. [환경 변수 예시](../apps/community/.env.example)와 [배포 안내](../apps/community/deploy/README.md)를 참고하세요. 기존 운영자의 계정이나 공개 데모 주소를 설치 기본값으로 사용하지 않습니다.

검증 명령은 저장소 루트의 `npm run build`, `npm test`, `npm run typecheck`입니다. 테스트 수와 실행 결과는 현재 체크아웃에서 확인합니다. 실제 모델·외부 서비스·PWA·기기 알림은 각 배포 환경에서 별도로 검증해야 합니다.

## 출처

기반 프레임워크는 [LING71671/open-grokbot](https://github.com/LING71671/open-grokbot)이며 GPL-3.0-only 라이선스와 원저작자 출처를 유지합니다. 추가 구현 범위는 `apps/community`의 웹앱·권한·미디어·원격 작업 공간·OpenClaw 연결과 배포·CI입니다. 상용 Grok Bot의 유출 소스나 자산은 포함하지 않습니다.
