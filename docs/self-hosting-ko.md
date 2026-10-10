# CustomCloudBot 직접 설치하기

CustomCloudBot은 설치자가 서버·AI·이름을 고르는 DIY 봇 플랫폼입니다. 기본 핑크·인디고 구름봇으로 시작하고, 관리자 설정에서 서비스 이름과 연결을 정합니다. 이 가이드는 새 계정과 빈 설정으로 시작하며 특정 운영자의 서버·키·메일을 사용하지 않습니다.

## 1. 실행할 환경 고르기

먼저 앱을 실행해 보려면 [로컬 Docker 또는 Node 시작 명령](../README.md#로컬에서-시작하기)을 사용하세요. `compose.portable.yml`은 localhost 앱과 영구 데이터만 실행하므로 클라우드 계정이나 systemd slice가 필요하지 않습니다. 공유 브라우저·터미널·파일까지 포함한 운영 설치에는 Linux 호스트, Docker Compose v2.24 이상, systemd/cgroup v2와 영구 저장 공간이 필요합니다. 저장소를 자신의 GitHub 계정으로 Fork하고 선택한 서버에 자신의 Fork를 체크아웃합니다.

서버는 OCI·AWS·Google Cloud·Azure 등 원하는 VM이나 자신이 운영하는 Linux 서버를 사용할 수 있습니다. Compose 템플릿은 cloud API로 서버를 만들지 않습니다. 선택한 OS에 맞춰 Docker를 설치하고 외부 접속용 도메인 또는 공인 IPv4를 준비하세요.

| 구성 예 | 설치자가 준비할 항목 |
| --- | --- |
| OCI + Cloudflare DNS | 본인 OCI 인스턴스·용량·네트워크, 본인 DNS 영역과 주소 |
| 다른 클라우드 VM | 본인 서버와 공인 주소, 방화벽, 영구 디스크 |
| 홈 서버 | Docker가 동작하는 Linux, 외부 HTTPS 연결 방식과 저장 공간 |
| AI | API 제공자의 계정·키 또는 지원되는 공식 CLI 구독 로그인 |

OCI Free Tier 대상 여부는 [Oracle의 현재 안내](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)와 본인 계정에서 확인합니다. 이전 설치의 CPU·RAM 수치를 새 계정의 무료 한도로 가정하지 마세요. 도메인·디스크·트래픽·AI에는 별도 요금이나 제한이 있을 수 있습니다.

## 2. 서버의 기본 설정 만들기

새 설치에서 저장소 루트 기준으로 실행합니다. 이미 운영 중이면 이 복사 명령 대신 아래 업그레이드 절차를 따르세요.

```sh
cd apps/community/deploy
cp .env.production.example .env.production
chmod 600 .env.production
```

`.env.production`에서 다음 값을 채웁니다. AI 키는 지금 넣지 않아도 됩니다.

| 변수 | 입력할 값 |
| --- | --- |
| `COMMUNITY_ORIGIN` | `https://`로 시작하는 실제 접속 origin, 뒤에 경로·슬래시 없음 |
| `COMMUNITY_PUBLIC_HOST` | 같은 도메인 또는 공인 IPv4, scheme 없음 |
| `COMMUNITY_CADDY_FILE` | 도메인은 `./Caddyfile.domain`, IPv4는 `./Caddyfile.ip` |
| `COMMUNITY_BOOTSTRAP_TOKEN` | 새 관리자 가입용 랜덤 비공개 값 |
| `COMMUNITY_SHARED_DESKTOP_ROOM` | 새로 생성한 소문자 UUID |
| `COMMUNITY_DESKTOP_HOME` | 공유 데스크톱 홈으로 쓸 전용 절대 경로 |

UUID는 `python3 -c 'import uuid; print(uuid.uuid4())'`, 초대 값은 `openssl rand -hex 32`로 만들 수 있습니다. 초대 값은 공개 문서나 Git에 넣지 않습니다. 홈 저장 경로는 전용 디렉터리를 만들고 UID/GID `10001:10001`이 사용할 수 있게 준비하세요. 개인 홈이나 서버 전체를 연결하지 않습니다.

자동 배포를 쓸 예정이면 홈 경로를 `<shared_storage_root>/home`으로 맞추고 크기가 제한된 별도 파일시스템으로 마운트해야 합니다. [배포 설치 도구](../scripts/deploy/README.md)가 새 빈 설치용 로컬 파일시스템을 준비할 수 있습니다. 기존 데이터가 있는 경로 위에 새 파일시스템을 덮어 마운트하지 마세요.

## 3. 네트워크와 작업 공간 준비하기

도메인을 쓰면 본인 DNS 영역에서 선택한 서버를 가리키도록 설정합니다. Cloudflare는 선택 사항이며, [DNS 레코드 생성 안내](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/)를 따릅니다. 이 앱에 Cloudflare 토큰을 넣지 않아도 수동으로 DNS를 설정할 수 있습니다.

호스트·클라우드 방화벽에서 사이트에 필요한 80/443 포트를 설정합니다. 앱 진단·VNC·CDP는 호스트 loopback에만 바인딩되며 파일·터미널 브리지 6083은 외부 공개하지 않습니다.

[배포 문서](../apps/community/deploy/README.md)와 [작업 공간 설치 문서](../apps/community/deploy/desktop/README.md)에 따라 다음 호스트 설정을 먼저 적용합니다.

1. `community.slice`를 설치해 컨테이너 자원을 집계합니다.
2. root 소유 `/etc/openclaw/desktop-network.env`에 자신의 `HOST_PUBLIC_IP`를 넣습니다.
3. 전용 desktop subnet의 egress guard, bridge sysctl과 Docker drop-in을 설치합니다.
4. 대시보드를 사용할 경우 read-only 호스트 수집기와 timer를 설치합니다.

컨테이너 subnet과 앱 고정 IP는 브리지 ACL·방화벽과 함께 사용됩니다. 네트워크를 바꾸려면 이 설정들을 함께 맞춰야 합니다. 모든 대화의 작업 공간은 같은 컴퓨터이므로 브라우저 로그인 상태와 파일을 공유할 사람만 초대하세요.

## 4. 실행하고 관리자 만들기

`apps/community/deploy`에서 실행합니다.

```sh
docker compose --env-file .env.production config --quiet
docker compose --env-file .env.production build
docker compose --env-file .env.production up -d --no-build
```

`--env-file`은 Compose 주소·경로 보간에도 필요합니다. 자격 증명이 포함될 수 있으므로 실제 운영 설정을 `config`로 화면에 출력하지 않고 `config --quiet`로 검증합니다. 도메인 DNS와 공개 80/443 연결이 준비되어야 인증서를 발급할 수 있습니다.

HTTPS 주소에서 초대 값으로 첫 계정을 만듭니다. 첫 계정이 관리자이며 이후 계정은 관리자의 새 초대로 가입합니다. 공유 작업 공간, 데이터와 인증서 볼륨은 다음 컨테이너 재생성에서도 보존합니다.

## 5. 내 봇 설정에서 이름과 AI 연결하기

관리자 사이드바의 **내 봇 설정**을 엽니다. 새 설치에 아직 AI가 없고 초기 설정을 마치지 않았다면 안내가 표시됩니다.

이름은 사이트 표시용입니다. 클라우드·도메인·메일은 자신의 배포 정보를 기록하는 항목입니다. 저장만으로 새 VM을 만들거나 기존 서버를 이동하지 않으며, DNS·HTTPS·메일함 인증을 실행하지 않습니다. 서버 주소를 실제로 바꿀 때는 DNS와 Caddy, `COMMUNITY_ORIGIN`을 함께 변경해야 합니다.

AI 실행 방식은 API 또는 전용 Gateway로 구성합니다. API는 원하는 공급자의 키를 추가하거나 OpenAI 호환 endpoint·모델·키를 지정합니다. Gateway는 설치자가 준비한 주소와 토큰을 입력합니다. 저장한 API/Gateway 설정은 재시작 없이 새 요청부터 적용됩니다. 비밀 값은 설정 화면에 다시 원문으로 노출하지 않습니다.

설정 화면의 recipe 내보내기는 선택한 구성의 JSON 설명을 저장합니다. API 키와 Gateway 토큰 값은 비워서 내보내며, 서버를 자동 생성하거나 실행하는 설치 파일은 아닙니다. 이름·주소 같은 설정 정보는 포함될 수 있으므로 공유 전 내용을 확인하세요.

Groq·Gemini·Hugging Face 조합은 연결할 수 있는 예시입니다. 무료 모델 목록과 계정별 한도는 변할 수 있으므로 공급자 화면에서 확인합니다.

| 제공자 | 확인할 내용 |
| --- | --- |
| [Groq](https://console.groq.com/docs/rate-limits) | 조직의 실제 요청·토큰 한도와 사용 가능한 모델 |
| [Gemini API](https://ai.google.dev/gemini-api/docs/rate-limits) | 프로젝트·사용 등급별 한도와 선택 모델 |
| [Hugging Face](https://huggingface.co/docs/inference-providers/pricing) | Inference Providers 크레딧·구독·과금 상태 |

여러 키가 같은 조직·프로젝트에 속하면 한도를 공유할 수 있습니다. 키 순환을 등록해도 공급자의 허용량이 늘거나 유료 모델이 무료가 되지는 않습니다. 앱 화면의 토큰 사용량·맥락 추정치와 실제 공급자 청구 내역도 구분합니다.

## 6. API 대신 구독으로 연결하기

구독 연결은 설치 후 각 제공자의 공식 CLI/OAuth 로그인으로 진행합니다. 계정 비밀번호나 인증 코드를 채팅에 넣지 말고 공식 로그인 화면에서 직접 입력하세요. API 키 등록과 구독 로그인은 별개의 인증 방식입니다.

Codex는 공식 CLI에서 ChatGPT 구독 로그인 또는 API 키 인증을 구분합니다. 원격 환경의 device-code 인증 가능 여부도 계정 설정에 따라 달라집니다. [공식 인증 문서](https://learn.chatgpt.com/docs/auth)를 확인하세요. CLI 로그인 성공만으로 이 웹앱의 모든 대화가 해당 CLI를 쓰는 것은 아닙니다. 앱의 실행 방식을 지원되는 Gateway로 연결해야 합니다.

이 설치에서 앱 Gateway까지 연결하는 구독 경로는 Codex의 공식 OAuth입니다. Claude와 Gemini helper는 각각 공식 CLI 로그인을 지원하지만 그 인증을 Gateway로 가져오거나 자동 공유하지 않습니다. 해당 제공자를 웹앱에서 쓰려면 지원되는 API 연결을 구성하세요. 각 구독의 이용 가능한 모델·한도·사용 범위는 제공자와 본인 계정에서 확인합니다.

구독 helper와 별도 writable Gateway 설정의 실제 명령은 [구독 연결 안내](../apps/community/scripts/README.md)를 참고하세요.

## 7. 메일·캘린더와 기타 서비스 연결하기

설정의 연락용 메일과 메일함 연결은 별개입니다. [빈 통합 Vault](../apps/community/integrations.example.json)를 서버의 비공개 파일로 복사하고 필요한 항목만 자신의 계정으로 채웁니다. 앱 컨테이너에만 마운트하고 그 안의 경로를 `COMMUNITY_INTEGRATIONS_FILE`에 지정하세요. 파일을 공유 데스크톱에 마운트하지 않습니다.

서비스마다 요구되는 동의와 권한이 다릅니다. 메일·캘린더·Meta 등의 실제 지원 동작은 [통합 문서](../apps/community/docs/integrations.md)를 확인합니다. 키 보관과 실행 어댑터 연결은 구분되므로 항목을 등록했다고 모든 서비스 동작을 할 수 있는 것은 아닙니다.

Web Push를 원하면 자신의 VAPID 키와 발신자 정보를 설정하고 기기에서 알림 권한을 허용한 뒤 실제 수신을 테스트합니다. 빈 상태에서는 푸시를 비활성화합니다.

## 8. Vault를 유지하며 업그레이드하기

업그레이드 전에 다음 데이터를 비공개 백업합니다.

| 데이터 | 보존 이유 |
| --- | --- |
| `COMMUNITY_DATA_DIR`의 SQLite·첨부 | 계정·대화·세션·업로드 보존 |
| `setup-vault.json`과 `setup-vault.key` | 관리자 설정과 API/Gateway 연결 복원에 둘 다 필요 |
| 기존 `.env.production`, `.env.openclaw`, `.env.providers` | 환경 기반 연결과 HTTPS·배포 설정 보존 |
| 외부 통합 Vault·CLI/Gateway 인증 볼륨 | 서비스 연결과 공식 로그인 상태 보존 |
| 공유 데스크톱 홈·Caddy 상태 | 파일·브라우저 로그인·인증서 보존 |

설정 Vault는 AES-256-GCM 암호화와 `0600` 파일 권한, `0700` 데이터 디렉터리를 사용합니다. 키와 암호문은 함께 보관하며, 복구를 확인하기 전 원본을 지우지 않습니다. 실행 중 SQLite는 backup API로 백업하세요.

새 예시 파일로 기존 환경 파일을 덮어쓰거나 키를 다시 만들 필요가 없습니다. `docker compose down -v`는 일반 업데이트 명령으로 사용하지 않습니다. 이름·아이콘 변경도 기존 계정·대화·Vault를 초기화하지 않습니다.

main 자동 배포는 [자동화 안내](../scripts/deploy/README.md)에 따라 자신의 저장소·서버·고정 SSH host key와 제한된 배포 자격 증명을 설정한 뒤 활성화합니다. 기존 설치는 `/etc/openclaw/compose.yml` 등 private manifest를 유지하며, 공개 템플릿이 운영 주소·볼륨·키를 덮어쓰지 않게 합니다. 내부 명령의 `openclaw` 및 `COMMUNITY_*` 이름은 호환성을 위해 남아 있습니다.

업데이트 후 `/api/health`의 release, 로그인, 짧은 모델 응답, 브라우저·터미널·파일을 확인합니다. 실제 모델 응답과 공식 CLI 로그인은 계정과 네트워크에서 검증해야 합니다.
