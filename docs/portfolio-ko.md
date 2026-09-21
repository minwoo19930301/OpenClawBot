# OpenClawBot 기반 공동 AI 작업 공간

[서비스](https://168.107.91.96) · [GitHub](https://github.com/minwoo19930301/OpenClawBot) · [CI](https://github.com/minwoo19930301/OpenClawBot/actions/workflows/ci.yml)

## 이력서용 요약

오픈소스 Open-Grokbot 프레임워크를 바탕으로 OpenClawBot 초대 기반 공동 AI 웹앱을 구현하고 OCI ARM 서버에 배포했습니다. OpenClaw 실행 엔진, 방별 접근 제어, 사진·음성 첨부, 브라우저에서 조작하는 원격 Linux 데스크톱을 연결했습니다.

- scrypt 비밀번호 해시, HttpOnly 세션, CSRF 방어, 일회성 초대와 방별 멤버 권한을 구현했습니다.
- 사진·음성 업로드의 크기·MIME·파일 서명을 검증하고, 공개 전 첨부 접근과 게시 후 방 멤버 접근을 분리했습니다.
- OpenClaw Gateway를 개인 봇과 분리하고 사용자·방·봇·턴별 세션 구분, 모델 호출 한도와 브라우저 도구 실행 제한을 적용했습니다.
- noVNC와 인증된 WebSocket 프록시로 원격 Linux 화면의 확대·키보드·마우스 제어를 구현하고, CDP로 봇의 브라우저 조작을 연결했습니다.
- Docker·Caddy HTTPS·SQLite 영속 볼륨으로 배포하고 GitHub Actions에서 빌드·테스트·타입 검사를 자동화했습니다.
- 선택적 PWA 설치와 VAPID 기반 Web Push 구독·세션별 정리·방 멤버 대상 일반 알림 계약을 추가했습니다.

**기술:** Node.js 24, JavaScript/TypeScript, SQLite, OpenClaw, Docker Compose, OCI ARM64, Caddy, noVNC, WebSocket, Playwright/CDP.

## 구현 범위와 검증

기반 프레임워크는 [LING71671/open-grokbot](https://github.com/LING71671/open-grokbot)이며 GPL-3.0-only 라이선스와 원저작자 출처를 유지합니다. 추가 구현 범위는 `apps/community`의 웹앱·권한·미디어·원격 데스크톱·OpenClaw 연결과 배포·CI입니다. 상용 Grok Bot의 유출 소스나 자산은 포함하지 않습니다.

PWA/Web Push 추가 후 커뮤니티 테스트 51개와 전체 빌드·타입 검사를 통과했습니다. 인증·방 권한·암호화 요청·알림 클릭 이동·구독 해제를 검증했습니다. 실제 OCI 서버의 OpenClaw `2026.9.5`에서 모델 응답을 받고, 공동 브라우저로 Example Domain을 연 뒤 내용을 읽어 한국어로 답하는 경로를 검증했습니다. PWA 설치와 실제 Web Push 수신은 배포 환경 및 브라우저별 별도 검증이 필요하며 아직 완료된 것으로 주장하지 않습니다. 이 문서는 동시 사용자 부하나 장기 운영 성과를 주장하지 않습니다.

사진·음성은 첨부·녹음·재생을 지원하며 이미지 인식·음성 전사는 아직 지원하지 않습니다. 방마다 데스크톱이 자동 생성되지는 않으며, 운영자가 별도 컨테이너를 연결합니다. 서비스 이용에는 초대 계정이 필요하고 모델 공급자의 요금과 사용 한도가 적용됩니다.
