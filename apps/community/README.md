# OpenGrokbot community app

이 앱은 [Open-Grokbot upstream](https://github.com/LING71671/open-grokbot)의 GPL-3.0-only clean-room 프레임워크를 바탕으로 별도 구현한 사용자 커뮤니티 표면입니다. upstream의 구조·런타임·프로토콜 문서는 저장소에 유지하며, 이 앱에서 추가한 계정 인증, 방별 ACL, 첨부파일, Docker/OCI 배포, 브라우저 데스크톱 프록시와 OpenClaw adapter의 범위를 설명합니다. 원본 제품과의 제휴를 주장하지 않으며 원본 소스·자산·비공개 자격 증명을 포함하지 않습니다.

라이브 링크: [https://168.107.91.96](https://168.107.91.96) · 초대 계정 필요

초대 기반 계정과 방별 권한을 제공하는 공동 대화 웹앱입니다. SQLite에 계정·세션·방·메시지·첨부 메타데이터를 저장하고, 사람 메시지와 선택한 봇의 응답을 같은 방에 표시합니다. UI는 공개적으로 재구성된 Grok Bot 0.18 화면의 어두운 구조와 색상을 참고하며, 차이와 근거는 [DESIGN-REFERENCE.md](DESIGN-REFERENCE.md)에 기록합니다.

## 현재 기능

- 일회성 가입 초대와 비밀번호 로그인, HttpOnly 세션 및 CSRF 보호
- 방 생성·방 초대·멤버 전용 메시지와 방별 권한
- 사람 메시지, 최대 3개 봇의 순차 응답, UTC 기준 요청 한도
- 사진 및 음성 파일 첨부(파일당 최대 12MiB, 메시지당 최대 4개)
- 브라우저의 명시적 동작으로 음성 녹음(최대 120초 또는 12MiB) 후 음성 첨부
- 방에 연결된 OCI 데스크톱의 상태 조회, 일회성 티켓, same-origin WebSocket VNC 프록시
- 설정된 방에서만 브라우저 도구를 사용할 수 있는 모델 도구 루프

첨부 파일은 멤버 인증 뒤에만 제공되며, 업로더가 메시지에 게시하기 전에는 업로더만 읽을 수 있습니다. 이미지 인식과 음성 전사는 구현하지 않았습니다. 모델은 첨부 내용을 보거나 듣지 않으며, 그렇게 주장해서도 안 됩니다.

## 로컬 실행

Node.js 24 이상이 필요합니다. 저장소 루트에서 의존성을 설치하고 runner, LLM, community workspace를 빌드한 뒤 community 서버를 시작합니다. Community build가 noVNC 정적 번들을 생성합니다.

```sh
npm ci --ignore-scripts
npm run build -w @open-grokbot/runner -w @open-grokbot/llm -w @open-grokbot/community
npm start -w @open-grokbot/community
```

환경 변수 예시는 `.env.example`에 있습니다. 파일을 자동으로 읽지 않으므로 실행 환경이나 서비스 관리자로 값을 전달하세요. 첫 가입에는 `COMMUNITY_BOOTSTRAP_TOKEN`이 필요하고, 이후에는 관리자 가입 초대를 사용합니다. OpenClaw 연결에는 `COMMUNITY_OPENCLAW_BASE_URL`과 `COMMUNITY_OPENCLAW_TOKEN`을 사용합니다. 직접 모델을 연결하려면 `COMMUNITY_LLM_BASE_URL`, `COMMUNITY_LLM_MODEL`, `COMMUNITY_LLM_API_KEY`가 모두 필요합니다. 두 연결 방식이 모두 설정되면 OpenClaw를 우선합니다. 모델 환경 변수와 provider/API key는 저장소에 넣지 않습니다. 두 백엔드 모두 비활성화하면 모델 호출 없이 사람 간 대화만 사용할 수 있습니다.

`COMMUNITY_DEMO=1`은 외부 모델을 호출하지 않는 기능 확인용 모드입니다. 사람끼리의 대화는 모델 연결 없이도 사용할 수 있고, 봇 요청은 연결 필요 오류를 표시합니다.

## 데스크톱과 브라우저 도구

`COMMUNITY_DESKTOP_MAP`은 방 UUID마다 전용 OCI 데스크톱 WebSocket 및 CDP endpoint를 매핑합니다. endpoint는 서버가 허용한 loopback 또는 전용 desktop 컨테이너 주소여야 하며, 한 endpoint를 여러 방이 공유할 수 없습니다. 클라이언트는 먼저 `GET /api/rooms/:id/desktop`으로 상태를 조회하고, 사용자가 연결을 요청할 때 `POST .../desktop/ticket`으로 짧은 수명의 티켓을 받은 뒤 same-origin WebSocket으로 연결합니다.

설정된 방의 봇 실행에는 모델 호출과 브라우저 도구 호출이 포함될 수 있습니다. 한 턴은 최대 4개 브라우저 action과 최대 5회의 모델 호출로 제한되며, 추가 모델 호출 전에 서버 quota callback을 통과해야 합니다. 설정되지 않은 방은 브라우저 도구를 사용하지 않습니다. OpenClaw 2.0 계열 gateway는 `COMMUNITY_OPENCLAW_BASE_URL`, `COMMUNITY_OPENCLAW_TOKEN`, 선택적 agent id를 서버 환경 변수로 명시했을 때 adapter를 통해 연결됩니다. 라이브 배포에서는 별도 `2026.9.5` Gateway와 실제 모델을 연결하고, 공동 브라우저에서 Example Domain을 열어 읽은 뒤 한국어 답변을 반환하는 경로를 검증했습니다.

방별 OCI 데스크톱은 운영자가 별도 컨테이너를 provision하고 서버 측 map에 등록해야 하며, 새 방에 자동으로 제공되지 않습니다.

## 배포

Docker/OCI 예시는 [deploy/README.md](deploy/README.md)에 있습니다. 공개 데모의 주소와 배포 구성은 재현을 위해 문서에 포함하며, 비밀 키·초대 토큰·개인 데이터는 서버에서만 관리합니다. 다른 서버에 배포할 때는 Caddy 주소, 방 UUID, 네트워크와 데스크톱 map을 함께 조정하세요.

## 검증

```sh
npm test -w @open-grokbot/community
```

현재 community 테스트는 39개이며 인증·권한·초대·첨부·데스크톱 티켓/프록시·CDP 연결·모델 도구 루프와 기본 방 동작을 점검합니다. 로컬 테스트는 `build`가 필요한 runner와 community 작업을 함께 확인하며, 공개 URL의 운영 부하 검증은 별도 작업입니다.

## 라이선스와 attribution

GNU GPL v3 only (SPDX: GPL-3.0-only). 공개 [Open-Grokbot upstream](https://github.com/LING71671/open-grokbot)의 코드와 라이선스를 유지하고 커뮤니티 앱을 추가했습니다. 원본 상용 Grok Bot의 유출 소스·자산·비공개 자격 증명은 포함하지 않습니다.
