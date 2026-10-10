# 공식 CLI 구독 연결

`connect-subscription.mjs`는 이미 설치된 공식 CLI의 로그인 명령을 실행하는 도우미입니다. 패키지 설치, 토큰 복사, 서비스 재시작이나 모델 요청을 자동으로 실행하지 않습니다. 명령은 공유 웹 터미널 대신 운영자가 신뢰하는 호스트 터미널에서 실행하세요.

| 연결 | 이 helper의 범위 |
| --- | --- |
| Codex | 공식 Codex CLI 로그인 또는 지원 버전 OpenClaw Gateway의 공식 Codex OAuth |
| Claude Code | 공식 CLI 로그인만; 앱 연결은 별도 API 설정 |
| Gemini CLI | 공식 Google 로그인만; 앱 연결은 별도 API 설정 |

CLI 구독 인증을 API 키 입력칸에 붙여넣지 않습니다. 로그인 상태는 CLI 또는 Gateway가 자신의 비공개 인증 저장소에 보관합니다. 계정의 권한과 한도가 적용되며 구독이 API 크레딧을 추가하지 않습니다.

## 공식 CLI만 사용하기

먼저 원하는 CLI를 공식 설치 안내에 따라 설치합니다. 저장소 루트에서 준비 상태를 확인합니다.

```sh
node apps/community/scripts/connect-subscription.mjs codex --check
node apps/community/scripts/connect-subscription.mjs claude --check
node apps/community/scripts/connect-subscription.mjs gemini --check
```

필요한 제공자 한 개를 골라 `--check` 없이 실행합니다. Codex는 기기 인증, Claude는 `claude auth login`, Gemini는 공식 CLI의 대화형 로그인 화면을 사용합니다. 공식 화면에서 본인 계정으로 승인하세요. `--check`는 CLI 설치 여부만 확인하며 로그인 성공이나 모델 이용 권한을 보장하지 않습니다.

CLI 로그인만으로 CustomCloudBot의 대화 엔진이 바뀌지는 않습니다. Claude·Gemini 로그인 정보를 앱이나 Gateway로 가져오는 기능은 제공하지 않습니다.

공식 문서: [OpenClaw 2026.9.5 OpenAI 설정](https://github.com/openclaw/openclaw/blob/v2026.9.5/docs/providers/openai/setup.md), [Codex 인증](https://learn.chatgpt.com/docs/auth), [Claude Code 인증](https://code.claude.com/docs/en/authentication), [Gemini CLI 인증](https://geminicli.com/docs/get-started/authentication/).

## Codex를 전용 Docker Gateway에 연결하기

다음은 [서버용 Compose](../deploy/README.md)를 준비한 설치에서 사용하는 선택 기능입니다. 로컬 앱 전용 `compose.portable.yml`에는 Gateway가 없습니다. 기본 `compose.yml`만 사용할 때 Gateway 설정은 읽기 전용이므로 구독 로그인용 override를 추가합니다.

Gateway 버전은 helper가 확인한 `2026.3.13`, `2026.3.13-1`, `2026.9.5`만 자동 연결합니다. 버전에 따라 공식 provider ID가 달라서 다른 버전은 추측하지 않고 중단합니다. 동봉 구독 템플릿은 현재 Compose의 `2026.9.5`용이며 공식 device-code 옵션을 사용합니다. 구버전 지원은 그 버전에 맞게 준비된 기존 Gateway의 로그인만을 의미합니다.

### 1. 비공개 설정 준비

`apps/community/deploy/.env.production`의 기본 서버 항목을 채우고, `.env.openclaw`를 `0600`으로 준비합니다. 처음 만드는 경우 `openclaw/.env.example`를 복사합니다. **기존 파일은 덮어쓰지 않습니다.**

두 환경 파일에 같은 `COMMUNITY_OPENCLAW_TOKEN`을 설정합니다. 신규 설치는 새 랜덤 값을 만들고, 이미 연결된 설치는 기존 토큰을 유지합니다. 이 값은 앱과 Gateway 사이의 인증 토큰이며 ChatGPT 구독 토큰이 아닙니다. `.env.production`에는 다음 연결 정보를 지정합니다.

```dotenv
COMMUNITY_OPENCLAW_BASE_URL=http://openclaw:18890
COMMUNITY_OPENCLAW_AGENT_ID=community
COMMUNITY_OPENCLAW_ALLOW_PRIVATE_HTTP=1
```

구독용 JSON은 API provider 키를 요구하지 않습니다. OAuth에 필요한 `openai` provider 플러그인만 허용하고 `models.providers.openai.agentRuntime.id`를 `openclaw`로 고정합니다. Native Codex 실행을 활성화하지 않으며 Gateway built-in tools·browser·cron·hooks는 비활성 상태를 유지합니다. 앱이 관리하는 도구 권한과 대화 경계를 사용합니다. Codex OAuth가 완료되면 공식 로그인 명령의 `--set-default`가 모델을 선택합니다. OAuth 완료 전에는 이 Gateway를 실제 대화 엔진으로 사용하지 마세요.

### 2. 처음 한 번 writable config 만들기

`apps/community/deploy`에서 실행합니다. 이 명령은 기존 Gateway 볼륨을 유지하고, 설정 파일이 이미 있으면 실패하여 덮어쓰지 않습니다. 기존 설치에서 실패했다면 파일을 지우고 다시 실행하지 말고 기존 설정·인증을 백업하고 사용할 설정을 확인하세요.

```sh
docker compose --env-file .env.production \
  -f compose.yml -f compose.subscription.yml \
  run --rm --no-deps --entrypoint node openclaw -e '
    const fs = require("node:fs");
    const dir = "/home/node/.openclaw";
    fs.mkdirSync(dir, {recursive:true, mode:0o700});
    fs.chmodSync(dir, 0o700);
    fs.copyFileSync("/etc/openclaw/subscription.example.json",
      dir + "/openclaw.json", fs.constants.COPYFILE_EXCL);
    fs.chmodSync(dir + "/openclaw.json", 0o600);
  '
docker compose --env-file .env.production \
  -f compose.yml -f compose.subscription.yml \
  --profile openclaw up -d --no-build openclaw
```

설정은 Gateway의 `community-openclaw` 볼륨 안 `/home/node/.openclaw/openclaw.json`에 저장됩니다. 상태 디렉터리는 `0700`, 설정 파일은 `0600`이어야 하며 컨테이너의 `node` 사용자가 쓸 수 있어야 합니다. 기존 Gateway 개인 상태나 다른 사용자의 CLI 인증 저장소를 대신 마운트하지 않습니다.

### 3. 공식 로그인 실행

저장소 루트로 돌아가 절대 경로를 지정합니다. 아래 명령의 `$(pwd)`는 현재 체크아웃 위치를 사용합니다.

```sh
node apps/community/scripts/connect-subscription.mjs codex \
  --gateway compose \
  --project-directory "$(pwd)/apps/community/deploy" \
  --compose-file "$(pwd)/apps/community/deploy/compose.yml" \
  --compose-file "$(pwd)/apps/community/deploy/compose.subscription.yml" \
  --project-name community --check
```

준비 상태가 확인되면 동일한 명령에서 `--check`만 빼고 실행합니다. helper는 `.env.production`을 Compose 보간에 사용하고, Gateway의 버전·파일 권한을 확인한 뒤 공식 OAuth를 시작합니다. 링크와 일회성 코드는 본인 터미널에서 확인하고 공식 로그인 화면에 입력합니다.

실제 운영 manifest가 `/etc/openclaw/compose.yml`에 있다면 첫 번째 `--compose-file`로 그 파일을 지정하세요. 읽기 권한이 있는 운영자 권한으로 실행하고, 현재 설치의 project/service 이름을 유지합니다. 필요하면 `--service`로 실제 Gateway 서비스 이름을 지정합니다. 자격 증명 파일의 권한을 넓혀 helper를 실행하지 마세요.

### 4. 앱에서 사용 확인

관리자의 **내 봇 설정**에서 Gateway 실행 방식을 선택하고 준비한 주소·토큰을 등록합니다. Gateway 연결 상태를 확인한 뒤 짧은 대화로 실제 응답을 확인합니다. 로그인 성공, Gateway health 성공과 선택 모델의 실제 사용 권한은 서로 다른 확인입니다.

Gateway 인증 상태와 writable config는 영구 볼륨에 저장됩니다. 배포할 때도 override의 `OPENCLAW_CONFIG_PATH`와 해당 볼륨을 유지하세요. 자동 배포에는 구독 override 내용을 root 소유 private manifest에 반영해 두어야 다음 release에서 읽기 전용 기본 설정으로 돌아가지 않습니다. 환경 파일, Gateway 인증 볼륨과 설정 Vault 백업을 함께 보관합니다.

## 호스트에 직접 설치된 Gateway

별도 전용 Gateway가 이미 설치되어 있고 비공개 writable config/state가 준비되어 있다면 다음처럼 확인합니다.

```sh
node apps/community/scripts/connect-subscription.mjs codex --gateway local --check
```

`OPENCLAW_CONFIG_PATH`와 `OPENCLAW_STATE_DIR`은 공식 Gateway가 쓰는 기존 위치를 가리켜야 합니다. 준비 상태 확인 후 `--check`를 빼고 로그인합니다. 이 helper가 다른 개인 Gateway의 구성·자격 증명을 옮겨주지는 않습니다.
