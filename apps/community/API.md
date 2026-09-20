# Community web API contract

Node.js 24 이상에서 실행하는 same-origin HTTP API입니다. 성공 응답은 JSON이고 오류는 `{ "error": "..." }` 형식입니다. 로그인·가입을 제외한 인증 요청은 HttpOnly `community_session` 쿠키가 필요합니다. GET을 제외한 인증 요청은 현재 세션의 `X-CSRF-Token`이 필요합니다. 배포 환경에서는 HTTPS와 `Secure; SameSite=Strict` 세션 쿠키를 사용합니다.

## 인증과 방

- `GET /api/session` → `{user, csrfToken, model, limits}`
- `POST /api/register` body `{username, displayName, password, inviteToken}` → session shape. 최초 가입은 `COMMUNITY_BOOTSTRAP_TOKEN`을 한 번 사용해 admin이 되며, 이후에는 일회성 관리자 초대가 필요합니다.
- `POST /api/login` body `{username,password}` → session shape
- `POST /api/logout` body `{}` → `{ok:true}`
- `GET /api/rooms` → `{rooms:[{id,name,description,role,memberCount}], bots:[{id,name,description}], usage:{used,limit}}`
- `POST /api/rooms` body `{name,description}` → `{room:...}`
- `POST /api/rooms/join` body `{token}` → `{room:...}`
- `GET /api/rooms/:id` → `{room,members,messages,busy}`. 멤버만 읽을 수 있고 최근 메시지 100개로 제한됩니다.
- `POST /api/rooms/:id/invites` body `{}` → `{token,expiresAt}`. 방장 또는 admin만 호출할 수 있습니다.
- `POST /api/admin/invites` body `{}` → `{token,expiresAt}`. admin만 호출할 수 있습니다.
- `GET /api/health` → `{ok:true,release:string}`

`POST /api/rooms/:id/messages` body는 `{text?, attachmentIds:[], botIds:[], clientNonce}`입니다. text는 첨부가 하나 이상이면 비어 있어도 됩니다. attachment ID는 같은 방의 업로더가 소유해야 하며 메시지당 최대 4개입니다. `botIds`가 비어 있으면 사람 메시지만 저장하고, 선택하면 최대 3개 봇이 공유 방 문맥에서 순차적으로 응답합니다. `clientNonce`는 재시도 중복을 막습니다.

## 사진·음성 첨부

- `POST /api/rooms/:id/attachments` — `multipart/form-data`의 `file` 필드. JPEG, PNG, WebP, GIF, WebM, Ogg, WAV, MP3, MP4를 허용하고 파일당 최대 12MiB입니다. 성공 응답은 `{attachment:{id,kind,name,mime,size,url}}`입니다.
- `GET /api/rooms/:id/attachments/:attachmentId` — private bytes 응답. 업로더는 메시지에 게시하기 전에도 읽을 수 있고, 게시된 첨부는 방 멤버가 읽을 수 있습니다. 이미지에는 일반 응답을, audio에는 `Range` 요청을 지원합니다.

첨부 metadata에는 서버 경로를 포함하지 않습니다. 모델에는 첨부 bytes가 전달되지 않으므로 사진 인식과 음성 전사는 구현되어 있지 않습니다. 클라이언트 MediaRecorder 녹음은 명시적인 사용자 클릭 뒤 시작하며 120초 또는 12MiB에서 중지됩니다.

## OCI 데스크톱

`COMMUNITY_DESKTOP_MAP`에 매핑된 방에서만 아래 endpoint를 사용할 수 있습니다. room UUID와 전용 desktop endpoint가 서버에서 검증되며 endpoint 중복과 외부 host는 거부됩니다.

- `GET /api/rooms/:id/desktop` → `{configured:boolean,available:boolean,browserEnabled:boolean}`. CDP `/json/version` 상태를 확인합니다.
- `POST /api/rooms/:id/desktop/ticket` body `{}` → `{websocketPath,expiresAt}`. CSRF, 세션, 방 멤버십을 확인하고 일회성·단기 티켓을 발급합니다.
- WebSocket `websocketPath` — `Origin`은 서비스 origin과 일치해야 합니다. 티켓은 room, user, session에 묶이고 한 번만 사용할 수 있습니다. 서버는 upstream OCI VNC WebSocket과의 binary frame을 양방향으로 전달하며 세션이 사라지면 연결을 종료합니다.

데스크톱 인증은 서비스 내부 proxy가 처리해야 하며, 클라이언트가 별도 VNC 자격 증명을 전송하지 않습니다.

## 모델과 브라우저 도구

`GET /api/session`의 `model`은 `{configured,demo,backend?}`를 반환합니다. OpenClaw를 선택한 경우에만 `backend: "openclaw"`가 추가됩니다. `configured`는 서버 설정 유무이며 공급자의 실시간 상태 확인 결과는 아닙니다.

OpenClaw가 설정되면 서버 전용 adapter가 별도 Gateway의 `/v1/responses`를 사용합니다. 앱이 인증된 사용자·방·봇과 턴별 nonce로 세션 키를 만들고, 브라우저 함수 호출 결과를 `function_call_output`으로 전달합니다. Gateway의 내장 도구는 별도 배포 설정에서 차단하며, Gateway의 인증 토큰과 세션 API는 클라이언트에 노출하지 않습니다. [공식 OpenResponses API](https://docs.openclaw.ai/gateway/openresponses-http-api)를 기준으로 구현했습니다.

`model.mjs`의 `ApiLlm`은 `COMMUNITY_LLM_BASE_URL/chat/completions`에 bearer key로 OpenAI 호환 요청을 보냅니다. OCI 데스크톱이 매핑된 방에서만 browser tool definitions를 포함합니다. 한 턴은 최대 4 browser actions와 최대 5 model calls로 제한되고, 두 번째 이후 모델 호출 전 `beforeAdditionalModelCall` quota callback을 통과해야 합니다. 알 수 없는 도구, 잘못된 tool call, action budget 초과는 거부됩니다. 브라우저 페이지 내용은 신뢰할 수 없는 자료로 취급됩니다.

모델 연결이 설정되지 않았거나 desktop mapping이 없는 방에서는 외부 도구를 실행했다고 주장하지 않습니다. 첨부 파일 내용 또한 모델에 제공되지 않습니다.

## PWA와 Web Push

Web Push는 VAPID 환경 변수 세 개가 모두 설정된 경우에만 활성화됩니다. VAPID private key는 서버 전용이며 API로 반환하지 않습니다.

- `GET /api/push/config` → `{configured:boolean,publicKey:string|null}`. 공개 VAPID key만 반환합니다.
- `POST /api/push/subscriptions` body `{subscription:{endpoint,keys:{p256dh,auth},expirationTime?},roomId?:string|null}` → `{ok:true}`. 인증·CSRF가 필요하며, `roomId`를 지정하면 현재 멤버인 방으로 제한됩니다.
- `DELETE /api/push/subscriptions` body `{endpoint:string}` → `{ok:true}`. 현재 사용자와 현재 세션에 속한 해당 endpoint만 삭제합니다.
- `POST /api/push/test` body `{endpoint:string}` → `{accepted:true}`. 현재 세션의 등록 endpoint에 일반 테스트 알림을 동기적으로 전송하고, provider가 성공 응답을 준 뒤 `202`를 반환합니다. 만료 endpoint는 `410`으로 정리합니다.

발송 본문에는 방 메시지·첨부·사용자명 같은 private content를 넣지 않습니다. 서버는 발송 시점의 방 멤버십을 다시 확인하고, 만료된 push endpoint를 정리합니다. 로그아웃은 해당 세션의 구독을 삭제합니다. 서비스 워커와 브라우저 권한은 HTTPS secure context가 필요하며, 실제 운영 브라우저에서 푸시가 도착하는지는 아직 검증하지 않았습니다.

## 클라이언트 동작

웹 클라이언트는 인증된 동안 선택한 방을 3초마다 조회하고, 메시지와 첨부 metadata를 DOM API와 `textContent`로 렌더링합니다. bot picker와 paperclip/record controls는 별도이며, room 변경·logout 때 pending upload, recorder, desktop ticket/socket을 폐기합니다.

운영 배포 절차와 Docker/Caddy 설정은 [deploy/README.md](deploy/README.md)에 있습니다. 자격 증명 값은 저장소와 이 문서에 기록하지 않습니다.
