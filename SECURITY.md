# Security policy

이 저장소의 보안 범위는 OpenGrokbot community app과 그 서버 측 배포·adapter 코드입니다. upstream 프레임워크와 외부 OCI, OpenClaw, 모델 provider 자체의 취약점은 해당 프로젝트의 보안 절차에도 함께 제보해 주세요.

## 운영 원칙

- 가입은 초대 코드로 제한하고, 방·메시지·첨부·데스크톱 endpoint는 세션과 방 멤버십으로 다시 확인합니다.
- CSRF 토큰과 `HttpOnly; SameSite=Strict` 세션을 사용하며, production origin은 HTTPS여야 합니다.
- 모델/API key, bootstrap 초대, OpenClaw token, desktop endpoint는 server-only 환경 변수로 주입합니다. 저장소·브라우저 번들·로그에 넣지 마세요.
- LLM이 연결되지 않은 상태에서는 사람 간 대화만 사용할 수 있습니다. 이미지 인식과 음성 전사는 제공하지 않습니다.
- 방별 데스크톱은 수동 provision과 서버 측 map이 필요하며, 브라우저 도구는 제한된 action·provider-call quota 안에서만 실행됩니다.
- Web Push는 VAPID 환경 변수가 모두 있을 때만 켜지며, subscription 등록·삭제는 인증과 CSRF 검사를 거칩니다. 발송 시점에 방 멤버십을 다시 확인하고 push 본문에는 private content를 넣지 않습니다.
- VAPID private key와 subscription encryption keys는 server-only로 보관합니다. HTTPS secure context와 브라우저 권한이 필요하며, 실제 운영 전달 성공은 별도 검증 대상입니다.

## 제보 방법

재현 가능한 보안 문제는 공개 이슈에 비밀값이나 개인 데이터를 포함하지 말고, GitHub의 private Security Advisory 기능을 사용해 [minwoo19930301/open-grokbot](https://github.com/minwoo19930301/open-grokbot)에 제보해 주세요. 계정 탈취, 방 간 데이터 노출, credential 노출, arbitrary desktop/CDP 접근은 공개 재현 코드보다 먼저 비공개로 알려야 합니다.

제보에는 영향 범위, 재현 단계, 영향을 받는 파일 또는 endpoint, 완화 방법을 포함해 주세요. 실제 token·password·session cookie·첨부 파일을 붙이지 마세요. 운영 환경에서 발견한 문제라면 해당 credential을 즉시 폐기·교체하고, 공개 URL의 운영 상태는 별도로 확인해야 합니다.

## 공개 전 점검

```sh
git status --short --untracked-files=all
git diff --check
rg -n -i --hidden --glob '!.git/**' --glob '!node_modules/**' '(api[_-]?key|secret|password|token|private[_ -]?key|BEGIN .*PRIVATE KEY)' .
npm test -w @open-grokbot/community
```

`.env`, SQLite 데이터베이스/WAL, preview 상태와 생성된 vendor 번들은 Git과 Docker context에서 제외해야 합니다. 배포 문서의 host·region·room mapping·SSH 경로 같은 운영 metadata도 공개 전에 일반화하세요.
