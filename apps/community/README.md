# CustomCloudBot community app

원하는 이름과 AI 연결로 운영하는 자체 구축 봇 플랫폼입니다. 기본 화면은 핑크·인디고 구름봇을 사용하며, 관리자는 **내 봇 설정**에서 서비스 이름과 연결을 정합니다. 처음 설치한다면 [Fork 설치 가이드](../../docs/self-hosting-ko.md)를 먼저 보세요.

이 앱은 공개 [Open-Grokbot upstream](https://github.com/LING71671/open-grokbot)의 GPL-3.0-only 프레임워크를 바탕으로 구현한 공동 작업 공간입니다. 기존 OpenClawBot 설치와의 호환성을 위해 `COMMUNITY_*` 환경 변수, `@open-grokbot/*` 패키지와 내부 배포 이름을 유지합니다. 원본의 저작권·라이선스와 [디자인 참고 기록](DESIGN-REFERENCE.md)도 보존합니다.

## 시작과 설정

Docker가 설치되어 있으면 저장소 루트의 [앱만 시작하기](../../README.md#로컬에서-시작하기)로 먼저 사용할 수 있습니다. `deploy/compose.portable.yml`은 호스트 loopback에서 앱과 영구 데이터만 실행하며 OCI나 호스트 slice 설정이 필요하지 않습니다. 다음은 Node 개발 실행입니다.

Node.js 24 이상에서 저장소 루트 기준으로 실행합니다. Community build가 noVNC와 xterm 정적 번들을 생성합니다.

```sh
npm ci --ignore-scripts
npm run build -w @open-grokbot/runner -w @open-grokbot/llm -w @open-grokbot/community
cp apps/community/.env.example .env
chmod 600 .env
```

`.env`의 `COMMUNITY_BOOTSTRAP_TOKEN`을 새 비공개 초대 값으로 채운 뒤 실행합니다.

```sh
COMMUNITY_ORIGIN=http://127.0.0.1:8787 node --env-file=.env apps/community/server.mjs
```

서버는 `.env`를 자체적으로 읽지 않으므로 위 `--env-file`이나 서비스 관리자를 통해 전달해야 합니다. 로컬 데이터는 `.community-data`에 저장합니다. 운영에서는 HTTPS origin과 영구 데이터 디렉터리를 별도로 지정하세요. 첫 초대로 만든 계정이 관리자이며, 이후 가입에는 관리자가 발급한 초대가 필요합니다.

AI 미연결 신규 설치는 설정 안내를 표시합니다. 사이드바의 **내 봇 설정**은 관리자만 사용할 수 있습니다.

| 항목 | 동작 |
| --- | --- |
| 이름 | 표시할 봇 서비스 이름을 저장 |
| 클라우드·도메인·메일 | 설치자가 선택한 서버·주소·연락 정보 기록 |
| API | 원하는 공급자의 키 또는 호환 endpoint·모델 설정 |
| Gateway | 전용 Gateway 주소·토큰과 실행 방식 선택 |
| 구독 | 공식 CLI 로그인 도움말; 실제 앱 연결은 지원되는 Gateway 방식으로 별도 구성 |

클라우드 정보를 저장해도 VM을 생성하거나 이동하지 않습니다. 도메인 입력은 DNS나 `COMMUNITY_ORIGIN`을 자동으로 바꾸지 않으며, 연락용 메일 입력만으로 메일함이 연결되지 않습니다. 실제 DNS·HTTPS와 외부 서비스 인증을 따로 구성하세요.

API/Gateway 설정은 저장 후 새 요청부터 적용되며 앱 재시작이 필요하지 않습니다. 기존 환경 파일과 통합 Vault의 키는 계속 지원하고 설정 화면에서 임의 삭제하지 않습니다. API 구성이 없으면 모델 호출은 비활성화됩니다. `COMMUNITY_DEMO=1`은 외부 모델을 호출하지 않는 개발 확인용입니다.

## Vault와 업그레이드

설정 화면은 `COMMUNITY_DATA_DIR/setup-vault.json`에 AES-256-GCM으로 암호화한 설정을 저장하고, 암호화 키는 같은 디렉터리의 `setup-vault.key`에 보관합니다. 파일 권한은 `0600`, 데이터 디렉터리는 `0700`입니다. 둘을 함께 복원해야 하므로 백업에서 한쪽을 빠뜨리지 마세요. 이 파일 암호화는 해당 호스트 관리자에 대한 접근 차단을 의미하지 않습니다.

기존 `.env.production`, `.env.openclaw`, `.env.providers`, SQLite·첨부 데이터, 외부 통합 Vault와 공식 CLI 인증 저장소도 각각 유지합니다. 새 `.env.example`를 기존 설정 위에 복사하거나 데이터 볼륨을 삭제할 필요가 없습니다. 자동 배포와 private Compose 보존은 [배포 자동화 문서](../../scripts/deploy/README.md)를 참고하세요.

메일·캘린더·Meta 등의 연결은 [빈 Vault 예시](integrations.example.json)를 비공개 경로에 복사해 채운 뒤 `COMMUNITY_INTEGRATIONS_FILE`로 지정합니다. 선택적 관리자 개인 맥락 파일은 `COMMUNITY_AGENT_CONTEXT_FILE`로 지정하며 기본값은 비어 있습니다. 상세 범위는 [통합 도구 안내](docs/integrations.md)에 있습니다.

## 대화와 모델

대화별 멤버 인증, 일회성 초대, 비밀번호 로그인, HttpOnly 세션과 CSRF 보호를 제공합니다. 새 대화는 첫 메시지로 제목을 만들고, Fork는 기존 맥락을 이어 새 대화를 만듭니다. Compact는 이전 맥락을 요약하고, 컨텍스트 초기화는 표시된 대화 기록을 보존하면서 이후 모델 입력의 이전 맥락을 제외합니다.

대화·그룹의 고정, 보관, 이동과 사이드바 너비는 계정별로 저장합니다. 그룹 삭제는 대화 자체를 삭제하지 않습니다. 모델 작업 중에는 연결·도구 실행 등 진행 단계를 표시합니다.

API 연결은 [환경 변수 예시](.env.example)의 공급자 변수로도 구성할 수 있습니다. 직접 호환 endpoint는 `COMMUNITY_LLM_BASE_URL`, `COMMUNITY_LLM_API_KEY`, `COMMUNITY_LLM_MODEL`이 필요합니다. Gateway는 `COMMUNITY_OPENCLAW_BASE_URL`과 `COMMUNITY_OPENCLAW_TOKEN`을 사용합니다. 기존 환경 설정에서는 Gateway 연결을 우선하며, 설정 화면의 실행 방식으로 사용할 연결을 선택할 수 있습니다.

API 사용량은 공급자가 반환한 실제 usage와 quota 정보를 수집합니다. 모델 맥락 표시와 공급자 청구·구독 한도는 서로 다른 값입니다. 여러 키를 등록해도 같은 조직·프로젝트의 한도가 늘어나는 것은 아닙니다. 순환은 구성된 연결 범위에서 동작하며 공급자의 권한·요금·한도를 바꾸지 않습니다.

## 작업 공간

브라우저·터미널·파일 탭은 공유 Linux 컴퓨터를 각기 다른 화면으로 보여줍니다. 브라우저는 CDP로 페이지 영역을 조작하고, 터미널은 xterm에서 비루트 PTY로 연결하며 계정·대화별 셸 상태를 유지합니다. 파일은 공유 홈 목록과 8 MiB 이하 미리보기·다운로드를 제공합니다. 터미널은 일회용 세션 티켓과 same-origin WebSocket을 사용하고, 각 요청은 현재 대화 멤버 여부를 확인합니다.

`COMMUNITY_SHARED_DESKTOP_ROOM`에 자신의 기준 작업 공간 UUID를 설정하면 같은 컴퓨터와 파일 공간을 모든 대화에 연결합니다. 따라서 브라우저 로그인과 파일은 초대 사용자에게 공유됩니다. 공동 작업자에게 호스트 관리자 키·Docker socket을 제공하는 구성은 아닙니다. 공유 브라우저 조작은 순서를 보장하고 중복 화면 요청은 합칩니다.

`COMMUNITY_DESKTOP_MAP`은 기준 UUID와 서버가 허용한 desktop endpoint를 매핑합니다. 하나의 endpoint를 여러 독립 항목에 중복 등록하는 대신 공유 작업 공간 설정을 사용하세요. 공유 설정이 없으면 운영자가 방별 컨테이너와 map을 준비해야 합니다. 자세한 네트워크·보안·설치 절차는 [작업 공간 문서](deploy/desktop/README.md)에 있습니다.

## 미디어와 알림

사진·음성 첨부는 파일당 최대 12 MiB, 메시지당 최대 4개이며 녹음은 최대 120초입니다. 게시 전 파일은 업로더만, 게시 후 파일은 현재 대화 멤버만 읽을 수 있습니다. 이미지 이해와 음성 처리는 선택한 모델·미디어 백엔드가 지원하는 범위에서 동작합니다.

Web Push는 `COMMUNITY_PUSH_SUBJECT`, `COMMUNITY_PUSH_PUBLIC_KEY`, `COMMUNITY_PUSH_PRIVATE_KEY`를 모두 설정한 경우 활성화됩니다. HTTPS 사이트에서 브라우저의 설치·홈 화면 추가 기능을 사용하고 **알림 켜기**로 권한을 허용한 뒤 테스트 알림의 실제 기기 수신을 확인하세요. 서버 접수 성공과 기기 표시는 다를 수 있습니다.

알림 본문은 대화 내용 대신 일반적인 활동 안내이며 현재 멤버에게만 발송합니다. 로그아웃하면 해당 세션 구독을 정리합니다. 로그인·대화·첨부 응답은 서비스 워커에 저장하지 않습니다.

## 배포와 검증

[Docker 설치](deploy/README.md)는 설치자가 선택한 Linux 호스트에서 사용합니다. OCI·Cloudflare는 가능한 구성 예시이며 다른 클라우드나 직접 운영하는 서버도 선택할 수 있습니다. 실제 자동 배포는 자신의 저장소·대상·제한된 자격 증명을 준비한 후 활성화합니다.

```sh
npm test -w @open-grokbot/community
```

테스트는 인증·대화 권한·첨부·작업 공간·모델 도구·PWA 계약을 확인합니다. 실제 공급자 응답, 공식 CLI 로그인, 공개 HTTPS와 알림 수신은 설정한 환경에서 별도로 확인해야 합니다.

## 라이선스와 출처

GNU GPL v3 only (`GPL-3.0-only`). 공개 [Open-Grokbot upstream](https://github.com/LING71671/open-grokbot)의 코드와 라이선스를 유지하고 공동 작업 앱을 추가했습니다. 원본 상용 Grok Bot의 유출 소스·자산·비공개 자격 증명은 포함하지 않습니다.
